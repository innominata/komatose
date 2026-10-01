"""인코더-디코더 트랜스포머 (Attention is All You Need, 2017) from scratch 구현.

번역(seq2seq)을 위한 구조:
  - 인코더: 입력 문장 전체를 양방향 셀프어텐션으로 인코딩.
  - 디코더: 마스크드 셀프어텐션(미래 차단) + 크로스어텐션(인코더 출력 참조)으로 출력 생성.

안정적인 from-scratch 학습을 위해 Pre-LayerNorm 구조를 사용한다(잔차 경로에 정규화 전치).
한·영 공용 단일 vocab이므로 입력/출력 임베딩과 출력 투영 가중치를 모두 묶는다(weight tying).
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import torch
import torch.nn as nn
import torch.nn.functional as F

from .tokenizer import PAD_ID


@dataclass
class ModelConfig:
    vocab_size: int
    d_model: int = 256
    n_heads: int = 4
    n_enc_layers: int = 3
    n_dec_layers: int = 3
    d_ff: int = 1024
    max_len: int = 256
    dropout: float = 0.1
    pad_id: int = PAD_ID


class PositionalEncoding(nn.Module):
    """고정된 사인/코사인 위치 인코딩. 학습 파라미터가 없어 임의 길이에 일반화된다."""

    def __init__(self, d_model: int, max_len: int):
        super().__init__()
        pe = torch.zeros(max_len, d_model)
        position = torch.arange(max_len).unsqueeze(1).float()
        div_term = torch.exp(torch.arange(0, d_model, 2).float() * (-math.log(10000.0) / d_model))
        pe[:, 0::2] = torch.sin(position * div_term)
        pe[:, 1::2] = torch.cos(position * div_term)
        self.register_buffer("pe", pe.unsqueeze(0))  # (1, max_len, d_model)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return x + self.pe[:, : x.size(1)]


class MultiHeadAttention(nn.Module):
    """멀티헤드 어텐션. 셀프/크로스 어텐션 모두에 사용된다.

    mask: 점수에 더해지는 가산 마스크. 차단할 위치는 -inf, 나머지는 0.
          (B, n_heads, Lq, Lk) 로 브로드캐스트 가능해야 한다.
    """

    def __init__(self, d_model: int, n_heads: int, dropout: float):
        super().__init__()
        assert d_model % n_heads == 0, "d_model 은 n_heads 로 나누어떨어져야 한다"
        self.n_heads = n_heads
        self.d_head = d_model // n_heads
        self.q_proj = nn.Linear(d_model, d_model)
        self.k_proj = nn.Linear(d_model, d_model)
        self.v_proj = nn.Linear(d_model, d_model)
        self.out_proj = nn.Linear(d_model, d_model)
        self.dropout = nn.Dropout(dropout)

    def _split_heads(self, x: torch.Tensor) -> torch.Tensor:
        b, length, _ = x.shape
        return x.view(b, length, self.n_heads, self.d_head).transpose(1, 2)  # (B, H, L, d_head)

    def forward(
        self,
        query: torch.Tensor,
        key: torch.Tensor,
        value: torch.Tensor,
        mask: torch.Tensor | None = None,
    ) -> torch.Tensor:
        q = self._split_heads(self.q_proj(query))
        k = self._split_heads(self.k_proj(key))
        v = self._split_heads(self.v_proj(value))

        scores = (q @ k.transpose(-2, -1)) / math.sqrt(self.d_head)  # (B, H, Lq, Lk)
        if mask is not None:
            scores = scores + mask
        attn = self.dropout(F.softmax(scores, dim=-1))
        out = attn @ v  # (B, H, Lq, d_head)

        b, _, lq, _ = out.shape
        out = out.transpose(1, 2).contiguous().view(b, lq, self.n_heads * self.d_head)
        return self.out_proj(out)


class FeedForward(nn.Module):
    def __init__(self, d_model: int, d_ff: int, dropout: float):
        super().__init__()
        self.fc1 = nn.Linear(d_model, d_ff)
        self.fc2 = nn.Linear(d_ff, d_model)
        self.dropout = nn.Dropout(dropout)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.fc2(self.dropout(F.gelu(self.fc1(x))))


class EncoderLayer(nn.Module):
    """Pre-LN 인코더 레이어: 셀프어텐션 + FFN."""

    def __init__(self, cfg: ModelConfig):
        super().__init__()
        self.self_attn = MultiHeadAttention(cfg.d_model, cfg.n_heads, cfg.dropout)
        self.ff = FeedForward(cfg.d_model, cfg.d_ff, cfg.dropout)
        self.norm1 = nn.LayerNorm(cfg.d_model)
        self.norm2 = nn.LayerNorm(cfg.d_model)
        self.dropout = nn.Dropout(cfg.dropout)

    def forward(self, x: torch.Tensor, src_mask: torch.Tensor | None) -> torch.Tensor:
        h = self.norm1(x)
        x = x + self.dropout(self.self_attn(h, h, h, src_mask))
        h = self.norm2(x)
        x = x + self.dropout(self.ff(h))
        return x


class DecoderLayer(nn.Module):
    """Pre-LN 디코더 레이어: 마스크드 셀프어텐션 + 크로스어텐션 + FFN."""

    def __init__(self, cfg: ModelConfig):
        super().__init__()
        self.self_attn = MultiHeadAttention(cfg.d_model, cfg.n_heads, cfg.dropout)
        self.cross_attn = MultiHeadAttention(cfg.d_model, cfg.n_heads, cfg.dropout)
        self.ff = FeedForward(cfg.d_model, cfg.d_ff, cfg.dropout)
        self.norm1 = nn.LayerNorm(cfg.d_model)
        self.norm2 = nn.LayerNorm(cfg.d_model)
        self.norm3 = nn.LayerNorm(cfg.d_model)
        self.dropout = nn.Dropout(cfg.dropout)

    def forward(
        self,
        x: torch.Tensor,
        memory: torch.Tensor,
        tgt_mask: torch.Tensor | None,
        mem_mask: torch.Tensor | None,
    ) -> torch.Tensor:
        h = self.norm1(x)
        x = x + self.dropout(self.self_attn(h, h, h, tgt_mask))
        h = self.norm2(x)
        x = x + self.dropout(self.cross_attn(h, memory, memory, mem_mask))
        h = self.norm3(x)
        x = x + self.dropout(self.ff(h))
        return x


class Seq2SeqTransformer(nn.Module):
    def __init__(self, cfg: ModelConfig):
        super().__init__()
        self.cfg = cfg
        self.embed = nn.Embedding(cfg.vocab_size, cfg.d_model, padding_idx=cfg.pad_id)
        self.pos = PositionalEncoding(cfg.d_model, cfg.max_len)
        self.emb_dropout = nn.Dropout(cfg.dropout)
        self.encoder = nn.ModuleList([EncoderLayer(cfg) for _ in range(cfg.n_enc_layers)])
        self.decoder = nn.ModuleList([DecoderLayer(cfg) for _ in range(cfg.n_dec_layers)])
        self.enc_norm = nn.LayerNorm(cfg.d_model)  # Pre-LN 스택 마지막의 최종 정규화
        self.dec_norm = nn.LayerNorm(cfg.d_model)
        self.lm_head = nn.Linear(cfg.d_model, cfg.vocab_size, bias=False)

        # weight tying: 단일 vocab이므로 임베딩과 출력 투영을 공유.
        self.lm_head.weight = self.embed.weight
        self.apply(self._init_weights)

    @staticmethod
    def _init_weights(module: nn.Module) -> None:
        if isinstance(module, nn.Linear):
            nn.init.xavier_uniform_(module.weight)
            if module.bias is not None:
                nn.init.zeros_(module.bias)
        elif isinstance(module, nn.Embedding):
            nn.init.normal_(module.weight, mean=0.0, std=0.02)
            if module.padding_idx is not None:
                with torch.no_grad():
                    module.weight[module.padding_idx].zero_()

    # ---- 마스크 생성 ----
    def _pad_mask(self, ids: torch.Tensor) -> torch.Tensor:
        """(B, Lk) 토큰 → (B, 1, 1, Lk) 가산 마스크. pad 위치는 -inf."""
        keep = ids != self.cfg.pad_id  # True=유효
        return torch.where(keep[:, None, None, :], 0.0, float("-inf"))

    def _causal_mask(self, length: int, device: torch.device) -> torch.Tensor:
        """(1, 1, L, L) 상삼각 -inf 마스크. 미래 토큰을 차단."""
        full = torch.full((length, length), float("-inf"), device=device)
        return torch.triu(full, diagonal=1)[None, None]

    def _embed(self, ids: torch.Tensor) -> torch.Tensor:
        # 임베딩에 sqrt(d_model) 스케일을 곱하는 것은 원 논문의 관례.
        x = self.embed(ids) * math.sqrt(self.cfg.d_model)
        return self.emb_dropout(self.pos(x))

    def encode(self, src: torch.Tensor) -> torch.Tensor:
        src_mask = self._pad_mask(src)
        x = self._embed(src)
        for layer in self.encoder:
            x = layer(x, src_mask)
        return self.enc_norm(x)

    def decode(self, tgt: torch.Tensor, memory: torch.Tensor, src: torch.Tensor) -> torch.Tensor:
        tgt_mask = self._causal_mask(tgt.size(1), tgt.device) + self._pad_mask(tgt)
        mem_mask = self._pad_mask(src)  # 크로스어텐션에서 src 의 pad 차단
        x = self._embed(tgt)
        for layer in self.decoder:
            x = layer(x, memory, tgt_mask, mem_mask)
        return self.dec_norm(x)

    def forward(self, src: torch.Tensor, tgt: torch.Tensor) -> torch.Tensor:
        """teacher forcing 학습용. tgt 는 디코더 입력(보통 <bos> .. 마지막 직전).
        반환: (B, L_tgt, vocab) 로짓."""
        memory = self.encode(src)
        h = self.decode(tgt, memory, src)
        return self.lm_head(h)

    def num_params(self) -> int:
        # weight tying 때문에 중복 카운트를 피하려 고유 파라미터만 합산.
        seen = set()
        total = 0
        for p in self.parameters():
            if id(p) in seen:
                continue
            seen.add(id(p))
            total += p.numel()
        return total
