// Selectable avatar "skins" for the Gait view. All three share the exact same
// Mixamo skeleton naming (mixamorig:Hips/LeftLeg/RightLeg after GLTFLoader
// strips the colon), so GaitAvatar's bone-lookup and rest-pose rotation logic
// works unchanged for any of them - only the model file differs.
//
// Trimmed from 9 to these 3 after checking each against a forced asymmetric
// test pose (bent-knee/tilted-hip/lifted-foot, independent of live sensor
// data - see GaitView.jsx history). Soldier, Big Vegas, Brute, Arissa, Ch14,
// and Maw J Laygo were removed: Big Vegas/Brute/Arissa showed no visible
// response at all (straight/idle legs - the rig likely doesn't share this
// skeleton's naming, same failure class as Ch16_nonPBR below), and
// Soldier/Maw J Laygo/Ch14 responded but with a distorted, twisted result
// that isn't trustworthy for actual clinical use. Xbot, Marker Man, and
// Michelle all showed a clean asymmetric leg bend matching the test values -
// see GaitAvatar.jsx for the per-model arm rest-pose correction that makes
// all three (not just Xbot) hang their arms at their sides instead of
// T-posing.
export const GAIT_MODELS = [
  { id: 'xbot', label: 'Xbot', path: '/Xbot.glb' },
  { id: 'michelle', label: 'Michelle', path: '/Michelle.glb' },
  // FBX import (Mixamo character). Mixamo FBX exports are authored in
  // centimeters, unlike the meter-scale GLBs above, hence the 0.01 scale.
  { id: 'markerman', label: 'Marker Man', path: '/fbx/passive_marker_man.fbx', scale: 0.01 },
]

export const DEFAULT_GAIT_MODEL = GAIT_MODELS[0].id
