"""minRNN: 선형 순환(minGRU) 기반 seq2seq.

표준 GRU의 게이트는 h_{t-1}에 의존해 순차 계산만 가능하지만, minGRU(Feng et al., 2024)는
게이트를 입력에만 의존하게 만들어 점화식을 선형으로 바꾼다:

    h_t = (1 - z_t) ⊙ h_{t-1} + z_t ⊙ g(h̃_t),   z_t = σ(W_z x_t),  h̃_t = W_h x_t

이는 h_t = a_t ⊙ h_{t-1} + b_t 형태라 **병렬 스캔**으로 학습은 병렬, 추론은 순차 O(1)
(KV 캐시 없음)이 된다. 수치 안정성을 위해 로그공간 스캔(Heinsen)을 사용한다.

seq2seq 설계: 인코더 셀프어텐션 → 양방향 minGRU, 디코더 셀프어텐션 → causal minGRU,
크로스어텐션·FFN은 유지(트랜스포머 베이스라인과 동일 인터페이스). 위치 인코딩 없음(순환이 순서 내재).
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import torch
import torch.nn as nn
import torch.nn.functional as F

from .model import FeedForward, MultiHeadAttention
from .tokenizer import PAD_ID


def g(x: torch.Tensor) -> torch.Tensor:
    """후보 h̃ 를 양수로 만드는 연속 함수(로그공간 스캔에 필요)."""
    return torch.where(x >= 0, x + 0.5, torch.sigmoid(x))


def log_g(x: torch.Tensor) -> torch.Tensor:
    return torch.where(x >= 0, torch.log(F.relu(x) + 0.5), -F.softplus(-x))


def parallel_scan_log(log_a: torch.Tensor, log_b: torch.Tensor) -> torch.Tensor:
    """h_t = a_t·h_{t-1} + b_t (h_0=0) 를 로그공간 병렬 스캔으로 계산.

    log_a, log_b: (B, T, D).  반환 h: (B, T, D).
    유도: h_t = exp(A_t) · Σ_{i≤t} exp(log b_i − A_i),  A_t = cumsum(log a).
    """
    a_star = torch.cumsum(log_a, dim=1)
    log_h = a_star + torch.logcumsumexp(log_b - a_star, dim=1)
    return torch.exp(log_h)


class MinGRU(nn.Module):
    """선형 순환 셀. 학습은 병렬 스캔(forward), 추론은 순차(step)."""

    def __init__(self, d_model: int):
        super().__init__()
        self.to_zh = nn.Linear(d_model, 2 * d_model)

    def forward(self, x: torch.Tensor, keep: torch.Tensor | None = None) -> torch.Tensor:
        z_pre, h_tilde = self.to_zh(x).chunk(2, dim=-1)
        log_a = -F.softplus(z_pre)                    # log(1 - z) = log σ(−z_pre)
        log_b = -F.softplus(-z_pre) + log_g(h_tilde)  # log z + log g(h̃)
        if keep is not None:
            # 패딩 위치는 항등(a=1, b=0)으로 만들어 상태를 그대로 통과시킨다.
            m = keep.unsqueeze(-1)
            log_a = torch.where(m, log_a, torch.zeros_like(log_a))
            log_b = torch.where(m, log_b, torch.full_like(log_b, float("-inf")))
        return parallel_scan_log(log_a, log_b)

    @torch.no_grad()
    def step(self, x_t: torch.Tensor, h_prev: torch.Tensor) -> torch.Tensor:
        """추론용 1스텝. x_t:(B,D), h_prev:(B,D) → h_t:(B,D)."""
        z_pre, h_tilde = self.to_zh(x_t).chunk(2, dim=-1)
        z = torch.sigmoid(z_pre)
        return (1 - z) * h_prev + z * g(h_tilde)


class BiMinGRU(nn.Module):
    """양방향 minGRU(인코더용). 순방향·역방향을 합쳐 투영."""

    def __init__(self, d_model: int):
        super().__init__()
        self.fwd = MinGRU(d_model)
        self.bwd = MinGRU(d_model)
        self.proj = nn.Linear(2 * d_model, d_model)

    def forward(self, x: torch.Tensor, keep: torch.Tensor | None) -> torch.Tensor:
        f = self.fwd(x, keep)
        xb = torch.flip(x, dims=[1])
        kb = torch.flip(keep, dims=[1]) if keep is not None else None
        b = torch.flip(self.bwd(xb, kb), dims=[1])
        return self.proj(torch.cat([f, b], dim=-1))


@dataclass
class MinRNNConfig:
    vocab_size: int
    d_model: int = 512
    n_enc_layers: int = 6
    n_dec_layers: int = 6
    n_heads: int = 8          # 크로스어텐션용
    d_ff: int = 2048
    max_len: int = 128
    dropout: float = 0.1
    pad_id: int = PAD_ID


class EncoderLayerMinRNN(nn.Module):
    def __init__(self, cfg: MinRNNConfig):
        super().__init__()
        self.mix = BiMinGRU(cfg.d_model)
        self.ff = FeedForward(cfg.d_model, cfg.d_ff, cfg.dropout)
        self.norm1 = nn.LayerNorm(cfg.d_model)
        self.norm2 = nn.LayerNorm(cfg.d_model)
        self.dropout = nn.Dropout(cfg.dropout)

    def forward(self, x: torch.Tensor, keep: torch.Tensor) -> torch.Tensor:
        x = x + self.dropout(self.mix(self.norm1(x), keep))
        x = x + self.dropout(self.ff(self.norm2(x)))
        return x


class DecoderLayerMinRNN(nn.Module):
    def __init__(self, cfg: MinRNNConfig):
        super().__init__()
        self.mix = MinGRU(cfg.d_model)  # causal (순방향 순환)
        self.cross_attn = MultiHeadAttention(cfg.d_model, cfg.n_heads, cfg.dropout)
        self.ff = FeedForward(cfg.d_model, cfg.d_ff, cfg.dropout)
        self.norm1 = nn.LayerNorm(cfg.d_model)
        self.norm2 = nn.LayerNorm(cfg.d_model)
        self.norm3 = nn.LayerNorm(cfg.d_model)
        self.dropout = nn.Dropout(cfg.dropout)

    def forward(self, x: torch.Tensor, memory: torch.Tensor, mem_mask: torch.Tensor | None) -> torch.Tensor:
        x = x + self.dropout(self.mix(self.norm1(x)))
        h = self.norm2(x)
        x = x + self.dropout(self.cross_attn(h, memory, memory, mem_mask))
        x = x + self.dropout(self.ff(self.norm3(x)))
        return x


class MinRNNSeq2Seq(nn.Module):
    """트랜스포머 베이스라인과 동일한 encode/decode/forward 인터페이스를 갖춰
    기존 학습·번역 코드를 그대로 재사용한다."""

    def __init__(self, cfg: MinRNNConfig):
        super().__init__()
        self.cfg = cfg
        self.embed = nn.Embedding(cfg.vocab_size, cfg.d_model, padding_idx=cfg.pad_id)
        self.emb_dropout = nn.Dropout(cfg.dropout)
        self.encoder = nn.ModuleList([EncoderLayerMinRNN(cfg) for _ in range(cfg.n_enc_layers)])
        self.decoder = nn.ModuleList([DecoderLayerMinRNN(cfg) for _ in range(cfg.n_dec_layers)])
        self.enc_norm = nn.LayerNorm(cfg.d_model)
        self.dec_norm = nn.LayerNorm(cfg.d_model)
        self.lm_head = nn.Linear(cfg.d_model, cfg.vocab_size, bias=False)
        self.lm_head.weight = self.embed.weight  # weight tying
        self.apply(self._init_weights)

    @staticmethod
    def _init_weights(m: nn.Module) -> None:
        if isinstance(m, nn.Linear):
            nn.init.xavier_uniform_(m.weight)
            if m.bias is not None:
                nn.init.zeros_(m.bias)
        elif isinstance(m, nn.Embedding):
            nn.init.normal_(m.weight, mean=0.0, std=0.02)
            if m.padding_idx is not None:
                with torch.no_grad():
                    m.weight[m.padding_idx].zero_()

    def _mem_mask(self, src: torch.Tensor) -> torch.Tensor:
        keep = src != self.cfg.pad_id
        return torch.where(keep[:, None, None, :], 0.0, float("-inf"))

    def encode(self, src: torch.Tensor) -> torch.Tensor:
        keep = src != self.cfg.pad_id
        x = self.emb_dropout(self.embed(src))
        for layer in self.encoder:
            x = layer(x, keep)
        return self.enc_norm(x)

    def decode(self, tgt: torch.Tensor, memory: torch.Tensor, src: torch.Tensor) -> torch.Tensor:
        mem_mask = self._mem_mask(src)
        x = self.emb_dropout(self.embed(tgt))
        for layer in self.decoder:
            x = layer(x, memory, mem_mask)
        return self.dec_norm(x)

    def forward(self, src: torch.Tensor, tgt: torch.Tensor) -> torch.Tensor:
        return self.lm_head(self.decode(tgt, self.encode(src), src))

    def num_params(self) -> int:
        seen, total = set(), 0
        for p in self.parameters():
            if id(p) in seen:
                continue
            seen.add(id(p))
            total += p.numel()
        return total
