import { useEffect, useMemo, useRef } from 'react'
import { useGLTF } from '@react-three/drei'
import { useFrame, useLoader } from '@react-three/fiber'
import * as THREE from 'three'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js'

// Bone names from the Mixamo rig baked into these characters - Hips -> UpLeg
// -> Leg (the knee hinge) -> Foot per side. GLTFLoader strips the
// `mixamorig:` colon down to a plain prefix (`mixamorig:LeftLeg` becomes
// `mixamorigLeftLeg`); FBXLoader keeps the colon as-is. Both forms are
// checked so the same lookup works for either loader, confirmed by logging
// each loaded skeleton's actual bone names rather than assuming.
const BONE = {
  hips: ['mixamorigHips', 'mixamorig:Hips'],
  spine: ['mixamorigSpine', 'mixamorig:Spine'],
  leftHip: ['mixamorigLeftUpLeg', 'mixamorig:LeftUpLeg'],
  rightHip: ['mixamorigRightUpLeg', 'mixamorig:RightUpLeg'],
  leftKnee: ['mixamorigLeftLeg', 'mixamorig:LeftLeg'],
  rightKnee: ['mixamorigRightLeg', 'mixamorig:RightLeg'],
  leftFoot: ['mixamorigLeftFoot', 'mixamorig:LeftFoot'],
  rightFoot: ['mixamorigRightFoot', 'mixamorig:RightFoot'],
  leftArm: ['mixamorigLeftArm', 'mixamorig:LeftArm'],
  rightArm: ['mixamorigRightArm', 'mixamorig:RightArm'],
  leftForeArm: ['mixamorigLeftForeArm', 'mixamorig:LeftForeArm'],
  rightForeArm: ['mixamorigRightForeArm', 'mixamorig:RightForeArm'],
}

// Local axis each bone bends about, in ITS OWN rest-pose local space. Found by
// visual check against the live dashboard's calibrated knee angle (not a
// guess baked in from a generic Mixamo doc - rigs vary axis/sign).
const KNEE_AXIS = new THREE.Vector3(1, 0, 0)
const KNEE_SIGN = 1

// Same idea as KNEE_AXIS/KNEE_SIGN, for the thigh (UpLeg) bone driven by
// hipFlexL/R. Started as an unverified guess matching the knee's convention
// (both are sagittal-plane hinges) - confirmed wrong once tested live: lifting
// the knee forward (or bending forward at the hip while sitting) swung the
// thigh backward instead. Flipped per the plan already noted here; axis
// itself didn't need to change.
const HIP_FLEX_AXIS = new THREE.Vector3(1, 0, 0)
const HIP_FLEX_SIGN = -1

// There's no ankle IMU, so the foot has no measured angle - only a contact
// PHASE from the feet FSRs (useMetrics: footPhaseL/R, derived from the
// heel/toe-specific channels). This is a bounded visual cue, not a
// calibrated kinematic reading; it eases toward a target pitch each frame
// rather than snapping, so it reads as motion, not a glitch. Three phases:
// 'stance' (flat), 'swing' (heel unloaded - foot lifted, toes up for
// clearance), 'heel-only' (heel loaded but toes lifted - rocked back onto
// the heel while the foot stays down) - a bigger toe-up angle than swing so
// the two are visually distinguishable, not just numerically different.
const FOOT_AXIS = new THREE.Vector3(1, 0, 0)
const SWING_TOE_UP_DEG = 18
const HEEL_ONLY_TOE_UP_DEG = 32
const FOOT_EASE_PER_SEC = 10

// Hip-tilt / spine-lean axis (lateral lean, Z). Overridable per model.
const TILT_AXIS = new THREE.Vector3(0, 0, 1)

// No arm sensors exist, so this is a static rest-pose correction, not a
// measured reading: Mixamo characters load in a T-pose (arms straight out),
// which reads as broken/robotic on a standing avatar. Rotating each arm bone
// brings it down to the character's side instead.
//
// Three bugs stacked on the road to this, all traced back to the same root
// cause: the first version was derived from - and only ever verified against
// - Xbot.glb, and Xbot's rig happens to have identity rotations everywhere
// up the arm chain, which quietly hid two mistakes that only show up on a
// rig where that's NOT true (Michelle, Marker Man):
//
// 1) Rest DIRECTION was hardcoded from Xbot's bind pose (+X/-X) instead of
//    measured. Fixed: each ForeArm bone's rest-pose LOCAL position IS the
//    direction its Arm bone points at rest (position is independent of the
//    parent's rotation), so it's read fresh per loaded model now instead of
//    assumed from one reference model.
//
// 2) The correction was composed as `rest.multiply(correction)`, matching
//    every other bone here (knee bend, hip flex, foot pitch) - but those add
//    an INCREMENTAL rotation on top of an already-correct rest pose, while
//    the arm correction REPLACES a broken one. That composition only gives
//    the right answer when `rest` is identity (Xbot). Fixed: the arm bone's
//    quaternion is set to `correction` directly, nothing folded in.
//
// 3) `correction` rotates the LOCAL rest direction to the target direction,
//    but the arm bone's quaternion is itself LOCAL - relative to its parent
//    (the shoulder). world = parentWorld * local, so "local -Y" only means
//    "world down" when the shoulder's own WORLD rotation is identity (Xbot,
//    again). Fixed: the target gets rotated into the shoulder's current local
//    frame (by the inverse of the shoulder's world quaternion) before solving
//    for `correction`, so the result points the right way in the SCENE
//    regardless of what the shoulder bone itself is doing.
//
// A-pose, not straight down: each arm's WORLD-space target is angled 40 deg
// outward from vertical (about the Z axis) so the arms rest away from the
// body. Left points toward +X, right toward -X. Because the correction rotates
// each target into the shoulder's own local frame, this holds across every rig
// regardless of its baked shoulder orientation. (If the arms come out crossed
// on some model, swap the two target vectors.)
const ARM_OUT_DEG = 40
const LEFT_ARM_TARGET_DIR = new THREE.Vector3(0, -1, 0)
  .applyAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(ARM_OUT_DEG))
const RIGHT_ARM_TARGET_DIR = new THREE.Vector3(0, -1, 0)
  .applyAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(-ARM_OUT_DEG))

// Shared rig-driving logic for any loaded skeleton, regardless of which
// loader produced it (GLTFLoader vs FBXLoader both yield a normal three.js
// bone graph, so this doesn't need to know which one loaded `root`).
function useAvatarRig(root, { kneeLDeg, kneeRDeg, hipTiltDeg, hipFlexLDeg, hipFlexRDeg, footPhaseL, footPhaseR }, rig) {
  const bones = useRef({})
  const restQuat = useRef({})
  const armDownQuat = useRef({})
  const footAngle = useRef({ left: 0, right: 0 })

  // Per-model rig config. Defaults reproduce the Mixamo behaviour; a non-Mixamo
  // skin (e.g. Little RUNMO) passes its own bone-name map and, when its bones
  // spin on different local axes, axis/sign overrides - see gaitModels.js.
  const BONES = rig?.bones || BONE
  const cfg = useMemo(() => ({
    kneeAxis: rig?.kneeAxis ? new THREE.Vector3(...rig.kneeAxis) : KNEE_AXIS,
    kneeSign: rig?.kneeSign ?? KNEE_SIGN,
    hipFlexAxis: rig?.hipFlexAxis ? new THREE.Vector3(...rig.hipFlexAxis) : HIP_FLEX_AXIS,
    hipFlexSign: rig?.hipFlexSign ?? HIP_FLEX_SIGN,
    tiltAxis: rig?.tiltAxis ? new THREE.Vector3(...rig.tiltAxis) : TILT_AXIS,
    footAxis: rig?.footAxis ? new THREE.Vector3(...rig.footAxis) : FOOT_AXIS,
    hipFlexMin: rig?.hipFlexMin ?? -30,
    kneeMin: rig?.kneeMin ?? 0,
    leftArmTarget: new THREE.Vector3(0, -1, 0).applyAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(rig?.armOutDeg ?? ARM_OUT_DEG)),
    rightArmTarget: new THREE.Vector3(0, -1, 0).applyAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(-(rig?.armOutDeg ?? ARM_OUT_DEG))),
  }), [rig])

  useEffect(() => {
    bones.current = {}
    root.traverse((obj) => {
      if (!obj.isBone) return
      for (const [key, names] of Object.entries(BONES)) {
        if (names.includes(obj.name)) bones.current[key] = obj
      }
    })
    for (const [key, bone] of Object.entries(bones.current)) {
      restQuat.current[key] = bone.quaternion.clone()
    }

    // World matrices on a freshly cloned skeleton aren't guaranteed current -
    // needed below because the shoulder's WORLD rotation (not its own local
    // rotation) is what determines which LOCAL direction on the arm bone
    // actually points straight down in the scene.
    root.updateMatrixWorld(true)

    armDownQuat.current = {}
    const b = bones.current
    const armCorrection = (armBone, foreArmBone, targetWorldDir) => {
      if (!armBone || !foreArmBone || foreArmBone.position.lengthSq() < 1e-8 || !armBone.parent) return null
      const restDir = foreArmBone.position.clone().normalize()
      // targetWorldDir is a WORLD-space direction (down, angled 40 deg out);
      // the arm bone's own quaternion is LOCAL (relative to its parent, the
      // shoulder). Composing world = parentWorld * local means the target this
      // local quaternion needs to hit is targetWorldDir rotated into the
      // shoulder's local frame, i.e. by the INVERSE of the shoulder's current
      // world rotation - not targetWorldDir directly. Skipping this step is
      // what sent Michelle's arms up instead of down: her shoulder bone's own
      // rest rotation isn't identity the way Xbot's is, so a "local -Y" target
      // meant something other than world-down for her.
      const parentWorldQuat = armBone.parent.getWorldQuaternion(new THREE.Quaternion())
      const localTarget = targetWorldDir.clone().applyQuaternion(parentWorldQuat.invert())
      return new THREE.Quaternion().setFromUnitVectors(restDir, localTarget)
    }
    armDownQuat.current.left = armCorrection(b.leftArm, b.leftForeArm, cfg.leftArmTarget)
    armDownQuat.current.right = armCorrection(b.rightArm, b.rightForeArm, cfg.rightArmTarget)
  }, [root, cfg, BONES])

  useFrame((_state, delta) => {
    const b = bones.current
    const rest = restQuat.current
    if (b.leftKnee && rest.leftKnee) {
      const bend = THREE.MathUtils.degToRad(Math.max(cfg.kneeMin, kneeLDeg ?? 0)) * cfg.kneeSign
      const q = new THREE.Quaternion().setFromAxisAngle(cfg.kneeAxis, bend)
      b.leftKnee.quaternion.copy(rest.leftKnee).multiply(q)
    }
    if (b.rightKnee && rest.rightKnee) {
      const bend = THREE.MathUtils.degToRad(Math.max(cfg.kneeMin, kneeRDeg ?? 0)) * cfg.kneeSign
      const q = new THREE.Quaternion().setFromAxisAngle(cfg.kneeAxis, bend)
      b.rightKnee.quaternion.copy(rest.rightKnee).multiply(q)
    }
    if (hipTiltDeg != null) {
      const clamped = THREE.MathUtils.clamp(hipTiltDeg, -30, 30)
      // Freeze the Hips (pelvis root) at its rest pose. Hips is the root of the
      // skeleton, so rotating it swings the whole avatar - legs, torso, arms -
      // in world space. Holding it still keeps the lower body planted.
      if (b.hips && rest.hips) {
        b.hips.quaternion.copy(rest.hips)
      }
      // Drive the full tilt into the Spine instead, so only the upper body
      // leans relative to the frozen pelvis.
      if (b.spine && rest.spine) {
        const q = new THREE.Quaternion().setFromAxisAngle(cfg.tiltAxis, THREE.MathUtils.degToRad(clamped))
        b.spine.quaternion.copy(rest.spine).multiply(q)
      }
    }
    // Floor at -30 (not 0) so the thigh can extend backward behind the body,
    // not just swing forward. Human hip flexion goes forward (positive) AND
    // extends backward (negative) during push-off; clamping at 0 flattened all
    // extension to a neutral standing line. -30 deg is a realistic extension limit.
    if (b.leftHip && rest.leftHip) {
      const flex = THREE.MathUtils.degToRad(Math.max(cfg.hipFlexMin, hipFlexLDeg ?? 0)) * cfg.hipFlexSign
      const q = new THREE.Quaternion().setFromAxisAngle(cfg.hipFlexAxis, flex)
      b.leftHip.quaternion.copy(rest.leftHip).multiply(q)
    }
    if (b.rightHip && rest.rightHip) {
      const flex = THREE.MathUtils.degToRad(Math.max(cfg.hipFlexMin, hipFlexRDeg ?? 0)) * cfg.hipFlexSign
      const q = new THREE.Quaternion().setFromAxisAngle(cfg.hipFlexAxis, flex)
      b.rightHip.quaternion.copy(rest.rightHip).multiply(q)
    }

    const ease = 1 - Math.exp(-FOOT_EASE_PER_SEC * delta)
    const targetDeg = (phase) => {
      if (phase === 'swing') return SWING_TOE_UP_DEG
      if (phase === 'heel-only') return HEEL_ONLY_TOE_UP_DEG
      return 0
    }
    footAngle.current.left += (targetDeg(footPhaseL) - footAngle.current.left) * ease
    footAngle.current.right += (targetDeg(footPhaseR) - footAngle.current.right) * ease
    if (b.leftFoot && rest.leftFoot) {
      const q = new THREE.Quaternion().setFromAxisAngle(cfg.footAxis, THREE.MathUtils.degToRad(footAngle.current.left))
      b.leftFoot.quaternion.copy(rest.leftFoot).multiply(q)
    }
    if (b.rightFoot && rest.rightFoot) {
      const q = new THREE.Quaternion().setFromAxisAngle(cfg.footAxis, THREE.MathUtils.degToRad(footAngle.current.right))
      b.rightFoot.quaternion.copy(rest.rightFoot).multiply(q)
    }

    // Not composed onto `rest` like every other bone above - see the arm
    // target/correction comment: this correction replaces the rest pose rather
    // than adding to it, so `rest` must NOT be folded in here.
    const armDown = armDownQuat.current
    if (b.leftArm && armDown.left) {
      b.leftArm.quaternion.copy(armDown.left)
    }
    if (b.rightArm && armDown.right) {
      b.rightArm.quaternion.copy(armDown.right)
    }
  })
}

function GltfBody({ modelPath, scale, position, rig, ...motion }) {
  const { scene } = useGLTF(modelPath)
  const clone = useMemo(() => cloneSkeleton(scene), [scene])
  useAvatarRig(clone, motion, rig)
  return <primitive object={clone} scale={scale ?? 1} position={position} />
}

function FbxBody({ modelPath, scale, position, rig, ...motion }) {
  const fbx = useLoader(FBXLoader, modelPath)
  const clone = useMemo(() => cloneSkeleton(fbx), [fbx])
  useAvatarRig(clone, motion, rig)
  return <primitive object={clone} scale={scale ?? 1} position={position} />
}

export default function GaitAvatar({ modelPath, scale, position, rig, ...motion }) {
  const isFbx = modelPath.toLowerCase().endsWith('.fbx')
  return isFbx
    ? <FbxBody modelPath={modelPath} scale={scale} position={position} rig={rig} {...motion} />
    : <GltfBody modelPath={modelPath} scale={scale} position={position} rig={rig} {...motion} />
}

// Only the default skin is preloaded eagerly; the others (several MB each,
// the FBX ones tens of MB) load on demand when picked, via the same
// Suspense boundary GaitView already wraps this in.
useGLTF.preload('/Xbot.glb')
