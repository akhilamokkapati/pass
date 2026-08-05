// Selectable avatar "skins" for the Gait view. All three share the exact same
// Mixamo skeleton naming (mixamorig:Hips/LeftLeg/RightLeg after GLTFLoader
// strips the colon), so GaitAvatar's bone-lookup and rest-pose rotation logic
// works unchanged for any of them - only the model file differs.
export const GAIT_MODELS = [
  { id: 'xbot', label: 'Xbot', path: '/Xbot.glb' },
  { id: 'michelle', label: 'Michelle', path: '/Michelle.glb' },
  { id: 'soldier', label: 'Soldier', path: '/Soldier.glb' },
  // FBX imports (Mixamo characters). Mixamo FBX exports are authored in
  // centimeters, unlike the meter-scale GLBs above, hence the 0.01 scale -
  // confirmed working (Y Bot checked first as the simplest case) before
  // adding the rest at the same scale.
  { id: 'ybot', label: 'Y Bot', path: '/fbx/Y Bot.fbx', scale: 0.01 },
  { id: 'bigvegas', label: 'Big Vegas', path: '/fbx/Big Vegas.fbx', scale: 0.01 },
  { id: 'brute', label: 'Brute', path: '/fbx/Brute.fbx', scale: 0.01 },
  { id: 'arissa', label: 'Arissa', path: '/fbx/Arissa.fbx', scale: 0.01 },
  { id: 'ch14', label: 'Ch14', path: '/fbx/Ch14_nonPBR.fbx', scale: 0.01 },
  // Ch16_nonPBR.fbx (also tried) is excluded: its export contains duplicate
  // bone hierarchies (likely multiple outfit variants each bundling a full
  // skeleton), so the "first bone with this name" lookup can grab one that
  // isn't actually skinned to the visible mesh - legs never move. Confirmed
  // via logging the loaded skeleton's bone names (duplicates all the way
  // through), not just visual guessing.
  { id: 'mawjlaygo', label: 'Maw J Laygo', path: '/fbx/Maw J Laygo.fbx', scale: 0.01 },
  { id: 'markerman', label: 'Marker Man', path: '/fbx/passive_marker_man.fbx', scale: 0.01 },
]

export const DEFAULT_GAIT_MODEL = GAIT_MODELS[0].id
