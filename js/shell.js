// LIFE/OS — what the shell (js/app.js) offers pages that can't import it, since it imports them.
// app.js fills these in before the first page renders; pages read them when they mount.

export const shell = {
  version: '',
  /** The pages a person can start on: [{ id, title }] in nav order. */
  pages: [],
  /** Opens the Appearance dialog (template, light / dark). */
  openAppearance() {},
  /** The newest deployed version ('v0.11'), or null when it can't be checked (offline). */
  async latestVersion() {
    return null;
  },
  /** 'checking' | 'persistent' | 'best-effort' | 'unsupported' */
  storageState: () => 'checking',
};

export function provideShell(services) {
  Object.assign(shell, services);
}
