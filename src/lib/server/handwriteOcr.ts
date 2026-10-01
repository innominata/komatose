import sharp from "sharp";
import { rowHasOperation } from '../modelRegistry';
import { listRegistryRows } from './modelRegistryStore';
import { resolveLiveAssistant } from './assistantRoute';
import { executeModelTask } from './modelTaskRunner';
import type { TaskEngine } from '../aiTasks';
import { WorkflowError } from "./workflowStore";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_DRAWING = 4_000_000;

export const HANDWRITE_OCR_PROMPT =
	"This image is a handwritten Japanese character or short string on a blank pad. Copy the drawn Japanese exactly. Return only the characters. No translation, no romanization, no explanation. If nothing readable, return an empty string.";

export type HandwriteModelId = string;

export type HandwriteDeps = {
  model?: TaskEngine;
	installed?: () => Array<{ id: string }>;
	read?: (id: HandwriteModelId, jpeg: Buffer, abort: AbortSignal) => Promise<string>;
};

export function pickHandwriteModel(installed: Array<{ id: string }>): HandwriteModelId | null {
  return installed[0]?.id || null;
}

export function parseDrawingPng(value: unknown) {
	if (typeof value !== "string" || !value.trim())
		throw new WorkflowError("Draw a character before reading it");
	if (value.length > MAX_DRAWING) throw new WorkflowError("Handwritten drawing is too large");
	const comma = value.indexOf(",");
	const encoded = value.startsWith("data:") && comma >= 0 ? value.slice(comma + 1) : value;
	let bytes: Buffer;
	try {
		bytes = Buffer.from(encoded, "base64");
	} catch {
		throw new WorkflowError("Handwritten drawing is not a valid image");
	}
	if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_MAGIC))
		throw new WorkflowError("Handwritten drawing must be a PNG");
	return bytes;
}

export async function drawingToJpeg(png: Buffer) {
	return sharp(png).flatten({ background: "#ffffff" }).jpeg({ quality: 95 }).toBuffer();
}

export async function drawingLooksEmpty(jpeg: Buffer) {
	const { data } = await sharp(jpeg).greyscale().raw().toBuffer({ resolveWithObject: true });
	return data.every((value) => value > 250);
}

export function cleanHandwriteReading(text: string) {
	return (text.split("\n")[0] ?? "").replace(/^["'`]+|["'`]+$/g, "").trim();
}

async function runLocal(id: HandwriteModelId, jpeg: Buffer, abort: AbortSignal, model?: string) {
  const resolved = resolveLiveAssistant(id, model);
  if (resolved.row.disabled) throw new WorkflowError(`${resolved.row.name} is disabled`);
  const result = await executeModelTask(resolved.row, 'vision', { jpeg, lang: 'japanese', model: resolved.slug }, { abort });
  return cleanHandwriteReading(result.source);
}

export async function readHandwriting(
	image: unknown,
	abort: AbortSignal,
	deps: HandwriteDeps = {},
) {
	const jpeg = await drawingToJpeg(parseDrawingPng(image));
	if (await drawingLooksEmpty(jpeg))
		throw new WorkflowError("Draw a character before reading it");
  let selected: string | undefined;
  if (deps.model) {
    try { selected = resolveLiveAssistant(deps.model.engine, deps.model.model).row.id; }
    catch { throw new WorkflowError(`The selected Read Text / OCR model (${deps.model.engine}) is unavailable. Choose a model with a current passing test.`); }
  }
	const id = selected || pickHandwriteModel(
    (deps.installed ?? (() => {
      const rows = listRegistryRows().filter(row => !row.disabled && (row.implementedTasks == null || row.implementedTasks.includes('vision')));
      const passed = rows.filter(row => rowHasOperation(row, 'vision'));
      return passed.length ? passed : rows;
    }))());
	if (!id) {
		throw new WorkflowError(
			"Choose a model with a current passing Read Text / OCR test to read handwriting.",
		);
	}
	const read = deps.read ?? ((id, jpeg, signal) => runLocal(id, jpeg, signal, deps.model?.model));
	const source = await read(id, jpeg, abort);
	return { source: source.trim(), model: id };
}
