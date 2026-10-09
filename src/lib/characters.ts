import type { GlossaryTerm } from './types';

/** The snapshot keeps older assignments readable if a glossary entry is removed. */
export type CharacterAssignment = { characterId: string; name: string; source: string };

export function glossaryCharacters(terms: GlossaryTerm[]): GlossaryTerm[] {
  return terms.filter(term => term.kind === 'character' && term.id && term.translation.trim());
}

export function resolveCharacter(speaker: CharacterAssignment | undefined, terms: GlossaryTerm[]): GlossaryTerm | undefined {
  if (!speaker) return;
  return glossaryCharacters(terms).find(term => term.id === speaker.characterId)
    ?? { id: speaker.characterId, kind: 'character', source: speaker.source, translation: speaker.name };
}

export function characterLabel(character: GlossaryTerm | undefined): string {
  return character ? `${character.translation}${character.source ? ` (${character.source})` : ''}` : 'Unknown / unassigned';
}

export function characterContext(character: GlossaryTerm | undefined): string {
  if (!character) return 'Unknown / unassigned';
  return [characterLabel(character), character.notes?.trim(), character.aliases?.length
    ? `Recognize alternate spellings ${character.aliases.join(', ')}; use ${character.translation} as the canonical name spelling.` : '']
    .filter(Boolean).join(' · ');
}
