declare module "hyphenation.en-us" {
  const language: {
    id: string[];
    leftmin: number;
    rightmin: number;
    patterns: Record<string, string>;
  };
  export default language;
}
declare module "hypher" {
  export default class Hypher {
    constructor(language: unknown);
    hyphenate(word: string): string[];
  }
}

declare module "kuroshiro" {
  export default class Kuroshiro {
    init(analyzer: unknown): Promise<void>;
    convert(
      text: string,
      options?: { to?: string; mode?: string; romajiSystem?: string },
    ): Promise<string>;
  }
}

declare module "kuroshiro-analyzer-kuromoji" {
  export default class KuromojiAnalyzer {
    constructor(options?: { dictPath?: string });
  }
}
