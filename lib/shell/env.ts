/**
 * Host facts the shell is allowed to expose.
 *
 * Small on purpose: everything here is either already readable by any page
 * (`Intl` zone, navigator) or a build constant. Keeping it in its own module
 * lets the runtime and its tests share it without importing just-bash.
 */

/**
 * The user's IANA time zone.
 *
 * The sandbox has no `/etc/localtime`, and just-bash's `date` defaults to UTC.
 * Forwarding the zone keeps "today" and date arithmetic honest without
 * revealing anything a page cannot already read.
 */
export function hostTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}
