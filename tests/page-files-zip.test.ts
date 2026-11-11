import assert from 'node:assert/strict';
import { test } from 'node:test';
import JSZip from 'jszip';
import { commonFolder, expandPageFiles, isPageFile, zipEntryName, zipEntryType } from '../src/lib/pageFiles';

test('zip entries: pages only, skipping folders, dotfiles and macOS metadata', () => {
	assert.equal(zipEntryType('ch1/001.JPG'), 'image/jpeg');
	assert.equal(zipEntryType('ch1/002.psd'), 'image/vnd.adobe.photoshop');
	assert.equal(zipEntryType('__MACOSX/ch1/._001.jpg'), null);
	assert.equal(zipEntryType('ch1/.DS_Store'), null);
	assert.equal(zipEntryType('ch1/notes.txt'), null);
});

test('entry names drop the shared folder and keep sub-folders in order', () => {
	assert.equal(commonFolder(['ch1/a/001.png', 'ch1/b/001.png']), 'ch1/');
	assert.equal(commonFolder(['001.png', 'ch1/002.png']), '');
	assert.equal(zipEntryName('ch1/a/001.png', 'ch1/'), 'a - 001.png');
});

test('expandPageFiles unpacks archives and passes other files through', async () => {
	const zip = new JSZip();
	zip.file('Chapter 3/10.png', new Uint8Array([1]));
	zip.file('Chapter 3/2.jpg', new Uint8Array([2, 3]));
	zip.file('Chapter 3/readme.txt', 'hi');
	zip.file('__MACOSX/Chapter 3/._2.jpg', 'x');
	const bytes = await zip.generateAsync({ type: 'arraybuffer' });
	const archive = new File([bytes], 'ch3.cbz', { type: '' });
	const loose = new File([new Uint8Array([9])], 'cover.webp', { type: 'image/webp' });
	const bad = new File([new Uint8Array([0, 1, 2])], 'broken.zip', { type: 'application/zip' });
	assert.ok(isPageFile(archive));
	const { files, skipped } = await expandPageFiles([loose, archive, bad]);
	assert.deepEqual(files.map((f) => [f.name, f.type, f.size]).sort(), [
		['10.png', 'image/png', 1],
		['2.jpg', 'image/jpeg', 2],
		['cover.webp', 'image/webp', 1],
	]);
	assert.deepEqual(skipped, ['broken.zip could not be read as a zip']);
});
