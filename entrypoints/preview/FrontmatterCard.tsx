import { Fragment, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, EyeOff } from 'lucide-react';
import { baseName } from '@/lib/mcp/file-storage';
import { skillCommandName } from '@/lib/skills/commands';
import { SKILL_FILE_NAME, SKILLS_DIR } from '@/lib/skills/constants';

/**
 * The YAML frontmatter of a rendered markdown file, as a card.
 *
 * A `SKILL.md` opens with a block that *is* the skill's manifest — name,
 * description, license, allowed tools. Rendered as markdown it is not metadata
 * at all: the closing `---` becomes a setext underline and the mapping turns
 * into a heading. This card shows the same data the way it is meant to be read.
 *
 * Labels are the YAML field names themselves. They are what the user edits in the
 * source view, so the card doubles as documentation of the format instead of
 * introducing a second vocabulary. Keys outside the specification fall back to
 * the same key/value rows, which makes the card useful for any markdown file with
 * frontmatter, not just skills.
 *
 * Everything is optional and only present fields render: a manifest with a name
 * and a description stays two lines tall.
 */

/** Fields the card lays out itself; they must not repeat in the generic rows. */
const CONSUMED_FIELDS = new Set([
  'name',
  'title',
  'description',
  'summary',
  'license',
  'compatibility',
  'allowed-tools',
  'metadata',
  'disable-model-invocation',
]);

/** A field value as display text. Objects and arrays are handled elsewhere. */
function scalar(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/** A list field, accepting the spec's whitespace/comma-separated form too. */
function list(value: unknown): string[] {
  const items = Array.isArray(value) ? value.map(scalar) : (scalar(value) ?? '').split(/[\s,]+/);
  return items.filter((item): item is string => item !== null && item !== '');
}

/** `metadata` is a mapping of arbitrary string keys to scalar values. */
function metadataEntries(value: unknown): Array<[string, string]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
    const text = scalar(item);
    return text === null ? [] : [[key, text] as [string, string]];
  });
}

function isTruthy(value: unknown): boolean {
  return value === true || scalar(value)?.toLowerCase() === 'true';
}

/** A skill manifest is the spec's `SKILL.md` inside the extension-owned `skills/`. */
export function isSkillManifest(path: string): boolean {
  return path.startsWith(SKILLS_DIR) && baseName(path) === SKILL_FILE_NAME;
}

export interface FrontmatterCardProps {
  data: Record<string, unknown>;
  /** Storage path of the file; only used to recognise a skill manifest. */
  path: string;
}

export function FrontmatterCard({ data, path }: FrontmatterCardProps) {
  const { t } = useTranslation();

  const name = scalar(data.name) ?? scalar(data.title);
  const description = scalar(data.description) ?? scalar(data.summary);
  const license = scalar(data.license);
  const compatibility = scalar(data.compatibility);
  const tools = list(data['allowed-tools']);
  const metadata = metadataEntries(data.metadata);
  const hiddenFromModel = isTruthy(data['disable-model-invocation']);
  // The `/skill:<name>` trigger only exists for files the skill index reads.
  const command =
    isSkillManifest(path) && scalar(data.name) ? skillCommandName(scalar(data.name)!) : null;

  const extraFields = Object.entries(data).filter(([key]) => !CONSUMED_FIELDS.has(key));

  const rows: Array<{ label: string; content: ReactNode }> = [];
  // License is a field like the others: a badge in the header would name the
  // value without the key the user edits in the source view.
  if (license) rows.push({ label: 'license', content: license });
  if (compatibility) rows.push({ label: 'compatibility', content: compatibility });
  if (tools.length > 0) rows.push({ label: 'allowed-tools', content: <Chips items={tools} /> });
  if (metadata.length > 0) {
    rows.push({
      label: 'metadata',
      content: (
        <span className="flex min-w-0 flex-wrap gap-x-2 gap-y-1">
          {metadata.map(([key, value]) => (
            <span key={key} className="inline-flex min-w-0 items-baseline gap-1">
              <span className="text-muted-foreground">{key}</span>
              <span className="break-all">{value}</span>
            </span>
          ))}
        </span>
      ),
    });
  }
  for (const [key, value] of extraFields) {
    const text = scalar(value);
    if (text !== null) {
      rows.push({ label: key, content: <span className="break-words">{text}</span> });
      continue;
    }
    const items = list(value);
    if (items.length > 0) rows.push({ label: key, content: <Chips items={items} /> });
  }

  if (!name && !description && rows.length === 0) return null;

  return (
    <section className="mb-6 rounded-lg border border-border bg-muted/30 p-3">
      {(name || command || hiddenFromModel) && (
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {name && (
            <span className="break-all font-mono text-sm font-medium text-foreground">{name}</span>
          )}
          {command && <CommandChip command={command} />}
          {hiddenFromModel && (
            // Icon only, as in the Skills list: the tooltip carries the sentence.
            <span
              className="flex shrink-0 items-center rounded bg-muted px-1.5 py-0.5 text-muted-foreground"
              title={t('skills.list.hiddenFromModel')}
            >
              <EyeOff className="h-3 w-3" aria-hidden="true" />
            </span>
          )}
        </div>
      )}

      {description && (
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{description}</p>
      )}

      {rows.length > 0 && (
        <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 border-t border-border/60 pt-2 font-mono text-xs">
          {rows.map((row) => (
            <Fragment key={row.label}>
              <dt className="whitespace-nowrap text-muted-foreground">{row.label}</dt>
              <dd className="min-w-0">{row.content}</dd>
            </Fragment>
          ))}
        </dl>
      )}
    </section>
  );
}

function Chips({ items }: { items: string[] }) {
  return (
    <span className="flex min-w-0 flex-wrap gap-1">
      {items.map((item) => (
        <code
          key={item}
          className="rounded border border-border/60 bg-background/60 px-1 py-0.5 text-[11px]"
        >
          {item}
        </code>
      ))}
    </span>
  );
}

/** The `/skill:<name>` trigger, copyable — the same affordance as the Skills list. */
function CommandChip({ command }: { command: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`/${command}`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied; the trigger stays selectable text.
    }
  };

  return (
    <button
      type="button"
      onClick={() => void copy()}
      title={t('skills.list.copyCommand')}
      className="flex shrink-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      /{command}
    </button>
  );
}
