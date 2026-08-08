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
}

// Local axis each bone bends about, in ITS OWN rest-pose local space. Found by
// visual check against the live dashboard's calibrated knee angle (not a
// guess baked in from a generic Mixamo doc - rigs vary axis/sign).
const KNEE_AXIS = new THREE.Vector3(1, 0, 0)
const KNEE_SIGN = 1

// Same idea as KNEE_AXIS/KNEE_SIGN, for the thigh (UpLeg) bone driven by
// hipFlexL/R. Starting guess matches the knee's convention (both are
// sagittal-plane hinges), but this has NOT been visually verified against a
// live calibrated hip-flexion reading yet the way the knee axis was - if the
// thigh swings the wrong way (or backwards) once this is live, flip
// HIP_FLEX_SIGN to -1 first before touching the axis itself.
const HIP_FLEX_AXIS = new THREE.Vector3(1, 0, 0)
const HIP_FLEX_SIGN = 1

// Upper body follows the same hip-tilt lean, at a fraction of the angle -
// a real torso doesn't rigidly copy the pelvis 1:1, it continues the lean
// more gently up the spine. Only meaningful now that hipTiltDeg is the real
// SIGNED value (see calibrateHipTilt in useMetrics.js) - this was NOT worth
// adding while hip tilt was unsigned, since it would've just doubled down on
// the "only ever leans one way" bug on two bones instead of one.
const TORSO_LEAN_FRACTION = 0.5

// There's no ankle IMU, so the foot has no measured angle - only a contact
// PHASE from the feet FSRs (useMetrics: footPhaseL/R, derived from the
// heel-specific channels). This is a bounded visual cue for foot clearance
// during swing, not a calibrated kinematic reading; it eases toward a target
// pitch each frame rather than snapping, so it reads as motion, not a glitch.
const FOOT_AXIS = new THREE.Vector3(1, 0, 0)
const SWING_TOE_UP_DEG = 18
const FOOT_EASE_PER_SEC = 10

// No arm sensors exist, so this is a static rest-pose correction, not a
// measured reading: Mixamo characters load in a T-pose (arms straight out),
// which reads as broken/robotic on a standing avatar. Rotating each arm bone
// brings it down to the character's side instead. First attempt used the Z
// axis and produced NO visible movement - on this rig, X is the confirmed
// "swing" axis for limb bones (KNEE_AXIS and HIP_FLEX_AXIS both use it, and
// both are visually verified working), so Z was very likely just twisting
// the arm around its own length instead of swinging it. Matching that
// convention here. Sign is opposite per side because the rig mirrors the
// bind pose left/right.
const ARM_DOWN_AXIS = new THREE.Vector3(1, 0, 0)
const ARM_DOWN_DEG = 75

// Shared rig-driving logic for any loaded skeleton, regardless of which
// loader produced it (GLTFLoader vs FBXLoader both yield a normal three.js
// bone graph, so this doesn't need to know which one loaded `root`).
function useAvatarRig(root, { kneeLDeg, kneeRDeg, hipTiltDeg, hipFlexLDeg, hipFlexRDeg, footPhaseL, footPhaseR }) {
  const bones = useRef({})
  const restQuat = useRef({})
  const footAngle = useRef({ left: 0, right: 0 })

  useEffect(() => {
    bones.current = {}
    root.traverse((obj) => {
      if (!obj.isBone) return
      for (const [key, names] of Object.entries(BONE)) {
        if (names.includes(obj.name)) bones.current[key] = obj
      }
    })
    for (const [key, bone] of Object.entries(bones.current)) {
      restQuat.current[key] = bone.quaternion.clone()
    }
  }, [root])

  useFrame((_state, delta) => {
    const b = bones.current
    const rest = restQuat.current
    if (b.leftKnee && rest.leftKnee) {
      const bend = THREE.MathUtils.degToRad(Math.max(0, kneeLDeg ?? 0)) * KNEE_SIGN
      const q = new THREE.Quaternion().setFromAxisAngle(KNEE_AXIS, bend)
      b.leftKnee.quaternion.copy(rest.leftKnee).multiply(q)
    }
    if (b.rightKnee && rest.rightKnee) {
      const bend = THREE.MathUtils.degToRad(Math.max(0, kneeRDeg ?? 0)) * KNEE_SIGN
      const q = new THREE.Quaternion().setFromAxisAngle(KNEE_AXIS, bend)
      b.rightKnee.quaternion.copy(rest.rightKnee).multiply(q)
    }
    if (hipTiltDeg != null) {
      const clamped = THREE.MathUtils.clamp(hipTiltDeg, -30, 30)
      if (b.hips && rest.hips) {
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(clamped))
        b.hips.quaternion.copy(rest.hips).multiply(q)
      }
      if (b.spine && rest.spine) {
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(clamped * TORSO_LEAN_FRACTION))
        b.spine.quaternion.copy(rest.spine).multiply(q)
      }
    }
    if (b.leftHip && rest.leftHip) {
      const flex = THREE.MathUtils.degToRad(Math.max(0, hipFlexLDeg ?? 0)) * HIP_FLEX_SIGN
      const q = new THREE.Quaternion().setFromAxisAngle(HIP_FLEX_AXIS, flex)
      b.leftHip.quaternion.copy(rest.leftHip).multiply(q)
    }
    if (b.rightHip && rest.rightHip) {
      const flex = THREE.MathUtils.degToRad(Math.max(0, hipFlexRDeg ?? 0)) * HIP_FLEX_SIGN
      const q = new THREE.Quaternion().setFromAxisAngle(HIP_FLEX_AXIS, flex)
      b.rightHip.quaternion.copy(rest.rightHip).multiply(q)
    }

    const ease = 1 - Math.exp(-FOOT_EASE_PER_SEC * delta)
    const targetDeg = (phase) => (phase === 'swing' ? SWING_TOE_UP_DEG : 0)
    footAngle.current.left += (targetDeg(footPhaseL) - footAngle.current.left) * ease
    footAngle.current.right += (targetDeg(footPhaseR) - footAngle.current.right) * ease
    if (b.leftFoot && rest.leftFoot) {
      const q = new THREE.Quaternion().setFromAxisAngle(FOOT_AXIS, THREE.MathUtils.degToRad(footAngle.current.left))
      b.leftFoot.quaternion.copy(rest.leftFoot).multiply(q)
    }
    if (b.rightFoot && rest.rightFoot) {
      const q = new THREE.Quaternion().setFromAxisAngle(FOOT_AXIS, THREE.MathUtils.degToRad(footAngle.current.right))
      b.rightFoot.quaternion.copy(rest.rightFoot).multiply(q)
    }

    if (b.leftArm && rest.leftArm) {
      const q = new THREE.Quaternion().setFromAxisAngle(ARM_DOWN_AXIS, THREE.MathUtils.degToRad(ARM_DOWN_DEG))
      b.leftArm.quaternion.copy(rest.leftArm).multiply(q)
    }
    if (b.rightArm && rest.rightArm) {
      const q = new THREE.Quaternion().setFromAxisAngle(ARM_DOWN_AXIS, THREE.MathUtils.degToRad(-ARM_DOWN_DEG))
      b.rightArm.quaternion.copy(rest.rightArm).multiply(q)
    }
  })
}

function GltfBody({ modelPath, scale, ...rig }) {
  const { scene } = useGLTF(modelPath)
  const clone = useMemo(() => cloneSkeleton(scene), [scene])
  useAvatarRig(clone, rig)
  return <primitive object={clone} scale={scale ?? 1} />
}

function FbxBody({ modelPath, scale, ...rig }) {
  const fbx = useLoader(FBXLoader, modelPath)
  const clone = useMemo(() => cloneSkeleton(fbx), [fbx])
  useAvatarRig(clone, rig)
  return <primitive object={clone} scale={scale ?? 1} />
}

export default function GaitAvatar({ modelPath, scale, ...rig }) {
  const isFbx = modelPath.toLowerCase().endsWith('.fbx')
  return isFbx
    ? <FbxBody modelPath={modelPath} scale={scale} {...rig} />
    : <GltfBody modelPath={modelPath} scale={scale} {...rig} />
}

// Only the default skin is preloaded eagerly; the others (several MB each,
// the FBX ones tens of MB) load on demand when picked, via the same
// Suspense boundary GaitView already wraps this in.
useGLTF.preload('/Xbot.glb')
