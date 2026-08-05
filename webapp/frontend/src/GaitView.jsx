import { Suspense, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls, Grid } from '@react-three/drei'
import GaitAvatar from './GaitAvatar.jsx'
import { GAIT_MODELS, DEFAULT_GAIT_MODEL } from './gaitModels.js'

// Drives the SAME calibrated numbers already shown on the Patient/Clinician
// cards (m.kneeLAngle, m.kneeRAngle, m.hipTilt) - not a separate data path,
// so calibration and staleness handling stay in one place (useMetrics).
export default function GaitView({ m }) {
  const kneeLOk = !!m?.kneeLOk
  const kneeROk = !!m?.kneeROk
  const [modelId, setModelId] = useState(() => localStorage.getItem('pass_gait_model') || DEFAULT_GAIT_MODEL)
  const pickModel = (id) => { setModelId(id); localStorage.setItem('pass_gait_model', id) }
  const model = GAIT_MODELS.find((mo) => mo.id === modelId) || GAIT_MODELS[0]

  return (
    <div>
      <div className="gait-skinpicker">
        <span className="gait-skinpicker-label">Avatar</span>
        {GAIT_MODELS.map((mo) => (
          <button key={mo.id} className={modelId === mo.id ? 'on' : ''} onClick={() => pickModel(mo.id)}>
            {mo.label}
          </button>
        ))}
      </div>
      <div className="gait-canvas-wrap">
        <Canvas camera={{ position: [2.4, 1.4, 2.4], fov: 45 }} shadows>
          <color attach="background" args={['#0b0e13']} />
          <ambientLight intensity={0.6} />
          <directionalLight position={[3, 5, 2]} intensity={1.2} castShadow />
          <directionalLight position={[-3, 2, -2]} intensity={0.4} />
          <Suspense fallback={null}>
            <GaitAvatar
              key={modelId}
              modelPath={model.path}
              scale={model.scale}
              kneeLDeg={kneeLOk ? m.kneeLAngle : 0}
              kneeRDeg={kneeROk ? m.kneeRAngle : 0}
              hipTiltDeg={m?.hipOk ? m.hipTilt : 0}
              footPhaseL={m?.footPhaseL}
              footPhaseR={m?.footPhaseR}
            />
          </Suspense>
          <Grid args={[10, 10]} position={[0, 0, 0]} cellColor="#29313d" sectionColor="#3a4552" fadeDistance={12} />
          <OrbitControls target={[0, 0.9, 0]} enableDamping />
        </Canvas>
        {!kneeLOk && !kneeROk && (
          <div className="gait-hint">No live knee data - showing the rest pose. Power on a knee node to see it move.</div>
        )}
      </div>
    </div>
  )
}
