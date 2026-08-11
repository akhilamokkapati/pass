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
  // Same Mixamo bone names as Xbot, but the UpLeg/Leg bones are exported with
  // the opposite bend handedness, so the shared KNEE_SIGN/HIP_FLEX_SIGN
  // defaults (tuned against Xbot) drive the thigh and knee backwards here.
  // Flipped both per-model rather than changing the shared default and
  // breaking Xbot.
  { id: 'michelle', label: 'Michelle', path: '/Michelle.glb', rig: { hipFlexSign: 1, kneeSign: -1 } },
  // FBX import (Mixamo character). Mixamo FBX exports are authored in
  // centimeters, unlike the meter-scale GLBs above, hence the 0.01 scale.
  // Same bend-handedness flip as Michelle - see comment above.
  { id: 'markerman', label: 'Marker Man', path: '/fbx/passive_marker_man.fbx', scale: 0.01, rig: { hipFlexSign: 1, kneeSign: -1 } },
  // Little RUNMO mascot - a custom (non-Mixamo) Sketchfab rig, so it needs an
  // explicit bone-name map. Its bones spin on their own local axes, so the
  // bend axes/signs below are tuned for this skeleton rather than the Mixamo
  // defaults. Note the model's arm naming is inverted (its "Forarm" bone is
  // the upper arm attached to the chest; its "Arm" bone is the forearm), and
  // it's ~3 units tall with its pivot near the chest, hence scale + Y lift.
  {
    id: 'runmo', label: 'Little RUNMO', path: '/little_runmo.glb',
    scale: 0.6, position: [0, 1.36, 0],
    rig: {
      // Names as three.js reports them after GLTFLoader strips the dots from
      // the source names (Leg.L_18 -> LegL_18). Arm naming is inverted in the
      // source rig: "Forarm" is the upper arm, "Arm" is the forearm.
      bones: {
        hips: ['Tas_19'],
        spine: ['Breast_10'],
        leftHip: ['LegL_18'],
        rightHip: ['LegR_14'],
        leftKnee: ['KneeL_17'],
        rightKnee: ['KneeR_13'],
        leftFoot: ['FeetBackL_16'],
        rightFoot: ['FeetBackR_12'],
        leftArm: ['ForarmL_9'],
        rightArm: ['ForarmR_6'],
        leftForeArm: ['ArmL_8'],
        rightForeArm: ['ArmR_5'],
      },
    },
  },
]

export const DEFAULT_GAIT_MODEL = GAIT_MODELS[0].id
