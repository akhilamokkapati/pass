import { useEffect, useMemo, useRef } from 'react'
import { useGLTF } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js'

// Bone names from the Mixamo rig baked into Xbot.glb - Hips -> UpLeg -> Leg
// (the knee hinge) -> Foot per side. GLTFLoader strips the `mixamorig:` colon
// down to a plain prefix (`mixamorig:LeftLeg` becomes `mixamorigLeftLeg`),
// confirmed by logging the loaded skeleton's actual bone names. Knee flexion
// rotates the Leg bone RELATIVE TO ITS OWN REST-POSE ORIENTATION (captured
// once on load), not to some assumed world axis - keeps this correct
// regardless of the bind pose.
const BONE = {
  hips: 'mixamorigHips',
  leftKnee: 'mixamorigLeftLeg',
  rightKnee: 'mixamorigRightLeg',
}

// Local axis each bone bends about, in ITS OWN rest-pose local space. Found by
// visual check against the live dashboard's calibrated knee angle (not a
// guess baked in from a generic Mixamo doc - rigs vary axis/sign).
const KNEE_AXIS = new THREE.Vector3(1, 0, 0)
const KNEE_SIGN = 1

export default function GaitAvatar({ kneeLDeg, kneeRDeg, hipTiltDeg }) {
  const { scene } = useGLTF('/Xbot.glb')
  // Clone the skinned scene so this component can mount more than once (React
  // strict-mode double-invoke, future multi-view) without fighting over one
  // shared skeleton - the standard pattern for reusing a skinned glTF.
  const clone = useMemo(() => cloneSkeleton(scene), [scene])

  const bones = useRef({})
  const restQuat = useRef({})

  useEffect(() => {
    bones.current = {}
    clone.traverse((obj) => {
      if (!obj.isBone) return
      for (const [key, name] of Object.entries(BONE)) {
        if (obj.name === name) bones.current[key] = obj
      }
    })
    for (const [key, bone] of Object.entries(bones.current)) {
      restQuat.current[key] = bone.quaternion.clone()
    }
  }, [clone])

  useFrame(() => {
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
    if (b.hips && rest.hips && hipTiltDeg != null) {
      const tilt = THREE.MathUtils.degToRad(Math.min(30, hipTiltDeg))
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), tilt)
      b.hips.quaternion.copy(rest.hips).multiply(q)
    }
  })

  return <primitive object={clone} />
}

useGLTF.preload('/Xbot.glb')
