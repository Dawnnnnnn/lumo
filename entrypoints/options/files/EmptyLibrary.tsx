/**
 * First-run state for a library view.
 *
 * The same shell the models page uses for `EmptyProviders`: a dashed panel with
 * a muted glyph above one line of copy, so an empty list reads as an invitation
 * rather than as a page that failed to load.
 *
 * Deliberately no button. The action that fills this view sits in the toolbar
 * directly above it, and a second copy would be the same control twice on one
 * screen — which is what makes an empty state feel like a sales pitch.
 */
export function EmptyLibrary({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-10 text-center">
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        {icon}
      </span>
      <p className="text-sm font-medium text-foreground">{label}</p>
    </div>
  );
}
