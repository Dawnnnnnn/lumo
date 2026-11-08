import { useTranslation } from 'react-i18next';
import { ExternalLink, ShoppingBag } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CHROME_STORE_URL, EDGE_STORE_URL, GITHUB_REPO_URL } from '@/lib/extension-info';
import { GithubIcon } from './GithubIcon';

/**
 * Where to get the other build, and where the code lives.
 *
 * Both store listings are offered even to someone already running one of them:
 * the listing is also the place to leave a review, and the running channel is
 * stated above anyway. A fixed order keeps the row from reshuffling per channel.
 */
export function AboutLinks() {
  const { t } = useTranslation();

  const links = [
    { href: CHROME_STORE_URL, labelKey: 'options.about.channels.chrome', icon: ShoppingBag },
    { href: EDGE_STORE_URL, labelKey: 'options.about.channels.edge', icon: ShoppingBag },
    { href: GITHUB_REPO_URL, labelKey: 'options.about.links.repo', icon: GithubIcon },
  ] as const;

  return (
    // Wraps rather than scrolls: the options pane narrows with the window.
    <div className="flex flex-wrap gap-2">
      {links.map(({ href, labelKey, icon: Icon }) => (
        <Button key={href} variant="outline" size="sm" asChild>
          <a href={href} target="_blank" rel="noreferrer">
            <Icon className="me-2 h-4 w-4 shrink-0" />
            <span className="truncate">{t(labelKey)}</span>
            <ExternalLink className="ms-2 h-3 w-3 shrink-0 opacity-60" />
          </a>
        </Button>
      ))}
    </div>
  );
}
