/**
 * Picking a skill folder must behave like dropping one.
 *
 * `<input type="file" webkitdirectory>` is the only way to reach a directory from
 * a click, and it reports structure solely through the non-standard
 * `webkitRelativePath`. Everything downstream (discovery, validation, install)
 * is shared with the drag-and-drop path, so the only thing that can go wrong
 * here is the path mapping — which is exactly what these cases pin down.
 */
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import {
  directoryEntriesFromFiles,
  directoryPackageSource,
  discoverSkills,
  zipPackageSource,
  type PickedFile,
} from '@/lib/skills/import';

/** A picked file, with the relative path the directory picker would report. */
function picked(name: string, relativePath: string, content = ''): PickedFile {
  const file = new File([content], name, { type: 'text/plain' }) as PickedFile;
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
  return file;
}

describe('directoryEntriesFromFiles', () => {
  it('keeps the path the picker reports, folder name included', () => {
    const entries = directoryEntriesFromFiles([
      picked('SKILL.md', 'pdf-tools/SKILL.md'),
      picked('parse.md', 'pdf-tools/references/parse.md'),
    ]);

    expect(entries.map((entry) => entry.path)).toEqual([
      'pdf-tools/SKILL.md',
      'pdf-tools/references/parse.md',
    ]);
  });

  it('falls back to the bare file name when the browser reports no path', () => {
    // A picker without `webkitRelativePath` hands back a flat list; a single-file
    // skill is still installable, so this must not be dropped.
    const plain = new File([''], 'SKILL.md') as PickedFile;
    expect(directoryEntriesFromFiles([plain]).map((entry) => entry.path)).toEqual(['SKILL.md']);
  });

  it('drops entries with no usable path', () => {
    const nameless = new File([''], '') as PickedFile;
    Object.defineProperty(nameless, 'name', { value: '' });
    expect(directoryEntriesFromFiles([nameless])).toEqual([]);
  });
});

describe('picked folder packages', () => {
  const manifest = '---\nname: pdf-tools\n---\nbody';

  it('discovers one skill rooted at the picked folder, with relative files', async () => {
    const source = directoryPackageSource(
      directoryEntriesFromFiles([
        picked('SKILL.md', 'pdf-tools/SKILL.md', manifest),
        picked('parse.md', 'pdf-tools/references/parse.md', '# parse'),
      ]),
    );

    const discovered = discoverSkills(await source.read());

    expect(discovered).toHaveLength(1);
    expect(discovered[0]!.root).toBe('pdf-tools/');
    expect(discovered[0]!.files.map((file) => file.path)).toEqual([
      'SKILL.md',
      'references/parse.md',
    ]);
  });

  it('installs every skill inside a picked parent folder', async () => {
    const source = directoryPackageSource(
      directoryEntriesFromFiles([
        picked('SKILL.md', 'bundle/a/SKILL.md', '---\nname: a\n---\n'),
        picked('SKILL.md', 'bundle/b/SKILL.md', '---\nname: b\n---\n'),
      ]),
    );

    expect(discoverSkills(await source.read()).map((skill) => skill.root)).toEqual([
      'bundle/a/',
      'bundle/b/',
    ]);
  });

  it('produces what the equivalent archive produces', async () => {
    // The point of the shared source boundary: choosing a folder and dropping a
    // zip of that folder must install the same thing.
    const archive = new Blob([
      zipSync({
        'pdf-tools/SKILL.md': strToU8(manifest),
        'pdf-tools/references/parse.md': strToU8('# parse'),
      }),
    ]);
    const fromZip = discoverSkills(await zipPackageSource(archive).read());
    const fromFolder = discoverSkills(
      await directoryPackageSource(
        directoryEntriesFromFiles([
          picked('SKILL.md', 'pdf-tools/SKILL.md', manifest),
          picked('parse.md', 'pdf-tools/references/parse.md', '# parse'),
        ]),
      ).read(),
    );

    expect(fromFolder.map((skill) => skill.root)).toEqual(fromZip.map((skill) => skill.root));
    expect(fromFolder[0]!.files.map((file) => file.path)).toEqual(
      fromZip[0]!.files.map((file) => file.path),
    );
  });
});
