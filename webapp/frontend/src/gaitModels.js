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
// that isn't trustworthy for actual clinical use. Xbot and Marker Man showed
// a clean asymmetric bend matching the test values; Michelle's legs did too
// (her arm rest-pose is still off, a separate known issue - see ARM_DOWN_QUAT
// in GaitAvatar.jsx, but that's cosmetic only and doesn't affect the knee
// reading itself).
export const GAIT_MODELS = [
  { id: 'xbot', label: 'Xbot', path: '/Xbot.glb' },
  { id: 'michelle', label: 'Michelle', path: '/Michelle.glb' },
  // FBX import (Mixamo character). Mixamo FBX exports are authored in
  // centimeters, unlike the meter-scale GLBs above, hence the 0.01 scale.
  { id: 'markerman', label: 'Marker Man', path: '/fbx/passive_marker_man.fbx', scale: 0.01 },
]

export const DEFAULT_GAIT_MODEL = GAIT_MODELS[0].id
