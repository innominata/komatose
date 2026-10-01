"""한·영 공용 BPE 토크나이저.

한국어와 영어를 한 토크나이저로 함께 다루기 위해 ByteLevel BPE(GPT-2 방식)를 사용한다.
바이트 단위로 분해하므로 어떤 유니코드(한글 포함)도 OOV 없이 처리된다.

특수 토큰:
  <pad> 0  패딩
  <bos> 1  문장 시작 (디코더 입력 선두)
  <eos> 2  문장 끝 (생성 종료 신호)
  <unk> 3  ByteLevel 특성상 거의 쓰이지 않지만 안전장치로 둔다.
  <2en> 4  방향 태그: 영어로 번역 (소스 선두에 부착)
  <2ko> 5  방향 태그: 한국어로 번역
"""
from __future__ import annotations

import argparse
from pathlib import Path

from tokenizers import Tokenizer, decoders, models, pre_tokenizers, trainers

PAD, BOS, EOS, UNK = "<pad>", "<bos>", "<eos>", "<unk>"
TAG_EN, TAG_KO = "<2en>", "<2ko>"
DOM_CASUAL, DOM_FORMAL = "<casual>", "<formal>"  # 도메인(레지스터) 태그
SPECIAL_TOKENS = [PAD, BOS, EOS, UNK, TAG_EN, TAG_KO, DOM_CASUAL, DOM_FORMAL]
(PAD_ID, BOS_ID, EOS_ID, UNK_ID, TAG_EN_ID, TAG_KO_ID,
 DOM_CASUAL_ID, DOM_FORMAL_ID) = range(8)


def tag_id(target_lang: str) -> int:
    """타깃 언어에 해당하는 방향 태그 ID. target_lang in {'en','ko'}."""
    return TAG_EN_ID if target_lang == "en" else TAG_KO_ID


def domain_tag_id(domain: str) -> int:
    """도메인(레지스터) 태그 ID. domain in {'casual','formal'}."""
    return DOM_CASUAL_ID if domain == "casual" else DOM_FORMAL_ID


def read_tsv_texts(tsv_path: str | Path) -> list[str]:
    """탭 구분 병렬 코퍼스(src<TAB>tgt)의 양쪽 컬럼을 모두 텍스트 목록으로 반환."""
    texts: list[str] = []
    with open(tsv_path, encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line:
                continue
            parts = line.split("\t")
            if len(parts) != 2:
                continue
            texts.extend(p.strip() for p in parts)
    return texts


def train_tokenizer(
    data_paths: list[str],
    out_path: str | Path,
    vocab_size: int = 2000,
    min_frequency: int = 2,
) -> Tokenizer:
    """ByteLevel BPE 토크나이저를 학습해 out_path(tokenizer.json)에 저장."""
    tokenizer = Tokenizer(models.BPE(unk_token=UNK))
    # add_prefix_space=True: 단어 앞 공백을 토큰에 포함해 어절 경계를 보존.
    tokenizer.pre_tokenizer = pre_tokenizers.ByteLevel(add_prefix_space=True)
    tokenizer.decoder = decoders.ByteLevel()

    trainer = trainers.BpeTrainer(
        vocab_size=vocab_size,
        min_frequency=min_frequency,
        special_tokens=SPECIAL_TOKENS,
        initial_alphabet=pre_tokenizers.ByteLevel.alphabet(),
        show_progress=False,
    )

    texts: list[str] = []
    for p in data_paths:
        texts.extend(read_tsv_texts(p))
    tokenizer.train_from_iterator(texts, trainer=trainer)

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tokenizer.save(str(out_path))
    return tokenizer


def load_tokenizer(path: str | Path) -> Tokenizer:
    return Tokenizer.from_file(str(path))


def encode(tokenizer: Tokenizer, text: str, add_bos: bool = False, add_eos: bool = False) -> list[int]:
    ids = tokenizer.encode(text).ids
    if add_bos:
        ids = [BOS_ID] + ids
    if add_eos:
        ids = ids + [EOS_ID]
    return ids


def decode(tokenizer: Tokenizer, ids: list[int]) -> str:
    """특수 토큰을 제거하고 문자열로 복원."""
    keep = [i for i in ids if i not in (PAD_ID, BOS_ID, EOS_ID)]
    return tokenizer.decode(keep)


def _main() -> None:
    ap = argparse.ArgumentParser(description="한·영 공용 BPE 토크나이저 학습")
    ap.add_argument("--data", nargs="+", required=True, help="병렬 코퍼스 TSV 경로(들)")
    ap.add_argument("--out", default="artifacts/tokenizer.json", help="저장 경로")
    ap.add_argument("--vocab-size", type=int, default=2000)
    ap.add_argument("--min-frequency", type=int, default=2)
    args = ap.parse_args()

    tok = train_tokenizer(args.data, args.out, args.vocab_size, args.min_frequency)
    print(f"saved: {args.out}")
    print(f"vocab size: {tok.get_vocab_size()}")
    sample = "안녕하세요 Hello"
    ids = encode(tok, sample, add_bos=True, add_eos=True)
    print(f"sample: {sample!r}")
    print(f"  ids: {ids}")
    print(f"  decoded: {decode(tok, ids)!r}")


if __name__ == "__main__":
    _main()
