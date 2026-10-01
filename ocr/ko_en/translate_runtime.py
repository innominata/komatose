"""Greedy decode used by the local Korean translator worker."""
from __future__ import annotations

import torch
import torch.nn.functional as F

from .tokenizer import BOS_ID, EOS_ID, decode, encode, tag_id


def _source_ids(tokenizer, text: str, device: str, target_lang: str | None):
    ids = encode(tokenizer, text, add_eos=True)
    if target_lang is not None:
        ids = [tag_id(target_lang)] + ids
    return torch.tensor([ids], dtype=torch.long, device=device)


@torch.no_grad()
def greedy_translate(model, tokenizer, text: str, device: str, target_lang: str | None = None, max_new: int = 128) -> str:
    src = _source_ids(tokenizer, text, device, target_lang)
    memory = model.encode(src)
    ys = torch.tensor([[BOS_ID]], dtype=torch.long, device=device)
    for _ in range(max_new):
        hidden = model.decode(ys, memory, src)
        next_id = int(model.lm_head(hidden)[:, -1].argmax(-1).item())
        ys = torch.cat([ys, torch.tensor([[next_id]], device=device)], dim=1)
        if next_id == EOS_ID:
            break
    return decode(tokenizer, ys[0].tolist())


@torch.no_grad()
def beam_translate(
    model,
    tokenizer,
    text: str,
    device: str,
    target_lang: str | None = None,
    max_new: int = 64,
    beam: int = 5,
    length_penalty: float = 0.8,
) -> str:
    """Length-normalized beam search. Greedy often stops on a short high-frequency phrase."""
    src = _source_ids(tokenizer, text, device, target_lang)
    memory = model.encode(src)
    live = [(0.0, [BOS_ID])]
    finished: list[tuple[float, list[int]]] = []
    for _ in range(max_new):
        if not live:
            break
        ranked: list[tuple[float, list[int]]] = []
        next_live: list[tuple[float, list[int]]] = []
        for logp, seq in live:
            ys = torch.tensor([seq], dtype=torch.long, device=device)
            logprobs = F.log_softmax(model.lm_head(model.decode(ys, memory, src))[:, -1][0], dim=-1)
            values, indexes = torch.topk(logprobs, beam)
            for value, index in zip(values.tolist(), indexes.tolist()):
                ranked.append((logp + float(value), seq + [int(index)]))
        ranked.sort(key=lambda item: item[0], reverse=True)
        for logp, seq in ranked:
            if seq[-1] == EOS_ID:
                length = max(1, len(seq) - 1)
                finished.append((logp / (((5 + length) / 6) ** length_penalty), seq))
            else:
                next_live.append((logp, seq))
            if len(next_live) >= beam:
                break
        live = next_live[:beam]
    pool = finished or live
    pool.sort(key=lambda item: item[0], reverse=True)
    return decode(tokenizer, pool[0][1])
