// .wick files: project data plus the library assets it uses. Kept apart from project.js (which needs the Studio UI) so
// the player that runs an exported game can read projects without loading any editor code.

/** Project data for a .wick file: the project plus a copy of every library asset it refers to. */
export function projectFileData(dm) {
  return { ...dm.toJSON(), assets: dm.assets.embed(dm.usedAssetIds()) };
}

/**
 * Takes project data read from a file, adds its embedded assets to the library, and returns plain project data. If
 * an asset id was already taken by a different file the asset is stored under a new id and references are rewritten.
 */
export async function importProjectData(data, assets) {
  const embedded = data?.assets;
  if (!embedded?.length) return data;
  const renamed = await assets.importEmbedded(embedded);
  let text = JSON.stringify({ ...data, assets: undefined });
  for (const [from, to] of renamed) text = text.replace(new RegExp(`asset://${from}(?![\\w-])`, 'g'), `asset://${to}`);
  return JSON.parse(text);
}
