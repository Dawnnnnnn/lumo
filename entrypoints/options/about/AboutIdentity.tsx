import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import {
  getExtensionId,
  getExtensionVersion,
  getReleaseChannel,
} from '@/lib/extension-info';

/**
 * Which build is running: logo, version, and where it came from.
 *
 * The channel line is the point of this block. A store build auto-updates but
 * trails the repository by however long review takes, while a build loaded from
 * a GitHub Actions artifact is current but never updates itself — and both can
 * be installed at once, as separate extensions. Naming the channel turns "which
 * one am I looking at" from guesswork into a glance, and the extension id
 * underneath is what makes a bug report unambiguous.
 */
export function AboutIdentity() {
  const { t } = useTranslation();
  const channel = getReleaseChannel();
  const version = getExtensionVersion();
  const extensionId = getExtensionId();
  // Both store listings behave identically — each review queue delays the same
  // release — so only the badge names the store; the sentence stays generic.
  const store = channel === 'github' ? null : channel;

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4 sm:flex-row sm:items-start sm:gap-5">
      {/* The packaged icon rather than a bespoke asset: this is the image the
          user already associates with the extension in the toolbar.
          `draggable={false}` because an <img> is a drag source by default, and
          dragging this one offers a chrome-extension:// URL to whatever it lands
          on — a gesture that means nothing here, unlike the deliberately
          draggable rows in the file manager. */}
      <img
        src="/icon/128.png"
        alt=""
        draggable={false}
        className="h-16 w-16 shrink-0 self-center rounded-xl sm:self-start"
      />

      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base font-semibold text-foreground">Lumo</h3>
          {version && (
            <Badge variant="outline" className="font-mono">
              v{version}
            </Badge>
          )}
          {/* Only a store build gets a badge, and it names the store it came
              from: that is the one claim worth asserting. Everything else is
              some flavour of local build, and the line below already says so
              without a pill implying an official channel. */}
          {store && <Badge variant="accent">{t(`options.about.channels.${store}`)}</Badge>}
        </div>

        <p className="text-xs leading-relaxed text-muted-foreground">
          {t(`options.about.channelDesc.${store ? 'store' : 'github'}`)}
        </p>

        {extensionId && (
          <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>{t('options.about.extensionId')}</span>
            {/* Selectable and monospaced: it gets pasted into issue reports. */}
            <code className="select-all break-all font-mono text-[11px] text-foreground">
              {extensionId}
            </code>
          </p>
        )}
      </div>
    </section>
  );
}
