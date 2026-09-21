// Scout's guided tour — five stops, each with a real DEMO the assistant performs with its own
// tools (Assistant Standard §E: navigate, narrate, demonstrate; one stop, then pause). Nothing
// here runs a lookup or writes to a case: demos are non-destructive by rule.
import type { Tour } from './kit/tourEngine';

export const LOOKOUT_TOUR: Tour = {
  persona: 'Lookout',
  intro: "I'm Scout. Lookout is your own eye on the world: live aircraft, ships, satellites, cameras and incidents on one globe, a photoreal 3D theater, and a case file underneath. Five stops — interrupt me any time.",
  stops: [
    {
      path: '/',
      label: 'The live globe',
      narration: 'This is the working map. Every dot is a live feed — flights, ships, cameras, quakes, incidents — and the layer panel switches them. Right-click anywhere for a place dossier.',
      demo: 'Call set_layer with layer "cctv" on, then fly_to lat 34.0195 lng -118.4912 zoom 13 (Santa Monica) so they watch camera dots arrive. Then call get_view_state and say how many layers are on, verbatim.',
    },
    {
      path: '/theater',
      label: 'The 3D theater',
      narration: "Same feeds, photoreal 3D — Google's tiles render the real buildings. The flat map is for working; this is for seeing.",
      demo: 'Call fly_to lat 34.0089 lng -118.4973 altitude_m 600 heading 40 pitch -30 (Santa Monica Pier). Then set_sensor_style "thermal", and after one sentence set_sensor_style "normal" — mention the seven looks live on keys 1 to 7.',
    },
    {
      path: '/theater',
      label: 'Contacts and follow',
      narration: "With flights on, any aircraft can be selected and followed — F for chase, C for cockpit, K for what's nearby. Contacts rank by distance from the selection.",
      demo: 'Call set_layer "flights" on, then nearby_contacts radius_km 80, and report the count exactly as returned with its scope. Only if an aircraft is actually listed: select_contact it, follow_aircraft "chase" for one sentence, then follow_aircraft "off". If none is listed, say so plainly.',
    },
    {
      path: '/console',
      label: 'The console',
      narration: 'Lookups by username, email, phone, domain, IP or image, with the case file underneath — every saved finding is hashed so it can be shown to have been collected as-is. Lookups are confirm-gated, and their results never leave this machine to me.',
      demo: 'Do NOT run a lookup. Call highlight with selector ".lk-inputwrap" and describe the sector picker and the case selector instead.',
    },
    {
      path: '/theater',
      label: 'Scenes and reconstruction',
      narration: 'Scenes are camera shot lists you save, replay and drop into a case. Reconstruction lays a case\'s evidence on a clock and a map, with the reported / observed / derived basis on every item.',
      demo: 'Call list_scenes and say how many there are — zero is fine, say so. Then close: the S key opens scenes, and the ⧗ Reconstruction link sits inside every case.',
    },
  ],
};
