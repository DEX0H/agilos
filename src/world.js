import * as THREE from 'three';
import { raycastWorld } from './physics.js';

// Shared combat state: everyone who can be shot, hitscan against them,
// line of sight, kills, and bullet tracers.

const _ray = new THREE.Ray();
const _pt = new THREE.Vector3();
const _dir = new THREE.Vector3();
const HEAD_ZONE = 0.45; // top 45 cm of a body counts as the head

export class World {
  constructor(scene, colliders) {
    this.scene = scene;
    this.colliders = colliders;
    this.combatants = [];
    this.tracers = [];
    this.killListeners = [];
  }

  add(c) {
    this.combatants.push(c);
  }

  remove(c) {
    const i = this.combatants.indexOf(c);
    if (i >= 0) this.combatants.splice(i, 1);
  }

  raycastWorld(origin, dir, maxDist) {
    return raycastWorld(origin, dir, maxDist, this.colliders);
  }

  // Clear line between two points?
  lineOfSight(a, b) {
    _dir.copy(b).sub(a);
    const d = _dir.length();
    if (d < 1e-4) return true;
    _dir.divideScalar(d);
    return raycastWorld(a, _dir, d, this.colliders) >= d - 0.05;
  }

  // Nearest live combatant along the ray, closer than maxDist, ignoring `exclude`
  raycastCombatants(origin, dir, maxDist, exclude) {
    _ray.set(origin, dir);
    let best = null;
    let bestDist = maxDist;
    for (const c of this.combatants) {
      if (c === exclude || c.dead) continue;
      if (!_ray.intersectBox(c.hitBox(), _pt)) continue; // shielded bodies still stop bullets
      const d = origin.distanceTo(_pt);
      if (d < bestDist) {
        bestDist = d;
        best = {
          target: c,
          point: _pt.clone(),
          distance: d,
          headshot: _pt.y > c.position.y + c.height - HEAD_ZONE,
        };
      }
    }
    return best;
  }

  onKill(fn) {
    this.killListeners.push(fn);
  }

  reportKill(killer, victim, how) {
    if (killer && killer !== victim) killer.kills++;
    for (const fn of this.killListeners) fn(killer, victim, how);
  }

  addTracer(a, b) {
    const geom = new THREE.BufferGeometry().setFromPoints([a.clone(), b.clone()]);
    const mat = new THREE.LineBasicMaterial({ color: new THREE.Color(4, 3, 1.6), transparent: true, opacity: 0.9 });
    const line = new THREE.Line(geom, mat);
    this.scene.add(line);
    this.tracers.push({ line, life: 0.06 });
  }

  update(dt) {
    // Safety net: anyone who leaves the map dies and respawns
    for (const c of this.combatants) {
      if (!c.dead && c.position.y < -20) {
        c.takeDamage(Infinity, null, true);
        this.reportKill(null, c, 'fell');
      }
    }

    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.life -= dt;
      if (t.life <= 0) {
        this.scene.remove(t.line);
        t.line.geometry.dispose();
        t.line.material.dispose();
        this.tracers.splice(i, 1);
      }
    }
  }
}
