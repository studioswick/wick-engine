// Wick library scripts: ready-made Lua scripts, stored as real .lua files under src/library/scripts and fetched when
// inserted (the service worker keeps them for offline use).

export const LIBRARY_SCRIPTS = [
  { id: 'spinner', name: 'Spinner', description: 'Turns the Part it is in around the Y axis.' },
  { id: 'bobber', name: 'Bobber', description: 'Floats a Part up and down.' },
  { id: 'coin_pickup', name: 'Coin Pickup', description: 'Collect on touch, counted in _G.coins, plays a Sound inside it.' },
  { id: 'jump_pad', name: 'Jump Pad', description: 'Launches whatever touches the Part.' },
  { id: 'moving_platform', name: 'Moving Platform', description: 'Slides a Part back and forth with easing.' },
  { id: 'respawn_on_fall', name: 'Respawn On Fall', description: 'Returns a Part to its start if it falls out of the world.' },
  { id: 'day_night', name: 'Day and Night Cycle', description: 'Starts a two-minute day by setting Lighting.DayLength.' },
  { id: 'hud_example', name: 'HUD Example', description: 'Builds a coin counter and a sliding panel from code.' },
  { id: 'player_controller', name: 'Player Controller', description: 'Movement, IK and camera for the Player bundle.' },
];

export async function libraryScriptSource(id) {
  const res = await fetch(new URL(`../library/scripts/${id}.lua`, import.meta.url));
  if (!res.ok) throw new Error(`Could not load the library script "${id}" (${res.status})`);
  return res.text();
}
