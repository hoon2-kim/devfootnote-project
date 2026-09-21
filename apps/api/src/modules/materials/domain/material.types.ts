export interface MaterialContentInput {
  body: string;
  title?: string;
  note?: string;
  context?: string;
  sourceUrl?: string;
}

export interface MaterialChunk {
  ordinal: number;
  text: string;
  startOffset: number;
  endOffset: number;
}

export interface PreparedMaterial {
  content: {
    body: string;
    title: string | null;
    note: string | null;
    context: string | null;
    sourceUrl: string | null;
  };
  fingerprint: string;
  normalizedText: string;
  chunks: MaterialChunk[];
}
