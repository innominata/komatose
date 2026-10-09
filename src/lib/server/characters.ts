import { characterContext, resolveCharacter, type CharacterAssignment } from '../characters';
import type { GlossaryTerm, LineRow } from '../types';
import type { RegionData } from '../workflow';
import { sqlite } from './db';
import { getDoc, putDoc, WorkflowError } from './workflowStore';
import { currentSeriesGlossary } from './seriesGlossary';

export function loadSpeakerAssignments(episodeId: string): Map<string, CharacterAssignment> {
  const rows = sqlite.prepare(`SELECT l.id,d.data FROM lines l JOIN workflow_docs d ON d.id='region:' || l.id
    WHERE l.episode_id=? AND json_type(d.data,'$.speaker')='object'`).all(episodeId) as { id: string; data: string }[];
  return new Map(rows.map(row => [row.id, (JSON.parse(row.data) as RegionData).speaker!]));
}

export function speakerContextForLines(lines: LineRow[], terms: GlossaryTerm[], assignments: Map<string, CharacterAssignment>): string {
  const entries = lines.flatMap(line => {
    const speaker = assignments.get(line.id);
    return speaker ? [`Region ${line.id} (${line.lineType}), original: ${line.source || '(not transcribed)'}\nSpeaker: ${characterContext(resolveCharacter(speaker, terms))}`] : [];
  });
  return entries.length ? `Human-assigned speakers (identify who is speaking, not who is being addressed; leave other speakers unknown):\n${entries.join('\n\n')}` : '';
}

export function assignCharacter(episodeId: string, seriesId: string, lineId: string, characterId: unknown, expectedRevision: number) {
  const line = sqlite.prepare('SELECT id FROM lines WHERE id=? AND episode_id=?').get(lineId, episodeId);
  if (!line) throw new WorkflowError('Region not found', 404);
  if (characterId !== null && (typeof characterId !== 'string' || !characterId))
    throw new WorkflowError('Select a character or clear the assignment');
  const current = getDoc<RegionData>(`region:${lineId}`, {});
  const data = { ...current.data };
  if (characterId === null) delete data.speaker;
  else {
    const character = currentSeriesGlossary(seriesId).find(term => term.kind === 'character' && term.id === characterId && term.translation.trim());
    if (!character) throw new WorkflowError('Character not found in this series glossary', 404);
    data.speaker = { characterId: character.id!, name: character.translation, source: character.source };
  }
  return putDoc(episodeId, current.id, data, expectedRevision);
}
