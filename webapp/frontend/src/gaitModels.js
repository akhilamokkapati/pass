// Selectable avatar "skins" for the Gait view. All three share the exact same
// Mixamo skeleton naming (mixamorig:Hips/LeftLeg/RightLeg after GLTFLoader
// strips the colon), so GaitAvatar's bone-lookup and rest-pose rotation logic
// works unchanged for any of them - only the model file differs.
export const GAIT_MODELS = [
  { id: 'xbot', label: 'Xbot', path: '/Xbot.glb' },
  { id: 'michelle', label: 'Michelle', path: '/Michelle.glb' },
  { id: 'soldier', label: 'Soldier', path: '/Soldier.glb' },
]

export const DEFAULT_GAIT_MODEL = GAIT_MODELS[0].id
