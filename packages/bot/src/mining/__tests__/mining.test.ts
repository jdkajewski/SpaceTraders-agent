import { describe, expect, it } from 'vitest';
import { makeShip } from '../../__tests__/fixtures.js';
import { mineRoleOf, parseCooldownMs, pickMineTender, shouldRelieveRawOre } from '../mining.js';

describe('mining helpers', () => {
  it('classifies mining roles by capabilities and explicit pins', () => {
    expect(mineRoleOf(makeShip({ mounts: [{ symbol: 'MOUNT_MINING_LASER_I' }], modules: [{ symbol: 'MODULE_ORE_REFINERY_I' }] }))).toBe('REFINER');
    expect(mineRoleOf(makeShip({ mounts: [{ symbol: 'MOUNT_SURVEYOR_II' }] }))).toBe('SURVEYOR');
    expect(mineRoleOf(makeShip({ mounts: [{ symbol: 'MOUNT_MINING_LASER_I' }] }))).toBe('DRONE');
    expect(mineRoleOf(makeShip({ symbol: 'AGENT-7' }), { funnelSyms: ['7'] })).toBe('FUNNEL');
    expect(mineRoleOf(makeShip({ symbol: 'AGENT-8' }), { transportSyms: ['8'] })).toBe('TRANSPORT');
    expect(mineRoleOf(makeShip({ cargo: { capacity: 80, units: 0, inventory: [] } }))).toBeNull();
    expect(mineRoleOf(makeShip({ mounts: [{ symbol: 'MOUNT_MINING_LASER_I' }] }), { mineFeed: false })).toBeNull();
  });

  it('applies raw-ore relief thresholds and active-target reserve', () => {
    expect(shouldRelieveRawOre({ rawUnits: 60, funnelLoad: 31, freeCapacity: 100, ore: 'COPPER_ORE', refineTarget: 'COPPER_ORE', clogAt: 32, oreReserve: 30, rawRelief: true })).toBe(0);
    expect(shouldRelieveRawOre({ rawUnits: 60, funnelLoad: 32, freeCapacity: 100, ore: 'COPPER_ORE', refineTarget: 'COPPER_ORE', clogAt: 32, oreReserve: 30, rawRelief: true })).toBe(30);
    expect(shouldRelieveRawOre({ rawUnits: 60, funnelLoad: 40, freeCapacity: 12, ore: 'IRON_ORE', refineTarget: 'COPPER_ORE', clogAt: 32, oreReserve: 30, rawRelief: true })).toBe(12);
    expect(shouldRelieveRawOre({ rawUnits: 60, funnelLoad: 40, freeCapacity: 100, ore: 'IRON_ORE', refineTarget: 'COPPER_ORE', clogAt: 32, oreReserve: 30, rawRelief: false })).toBe(0);
  });

  it('picks the auto mine tender and honors explicit transport override', () => {
    const miner = makeShip({ symbol: 'MINER', mounts: [{ symbol: 'MOUNT_MINING_LASER_I' }], cargo: { capacity: 80, units: 0, inventory: [] }, fuel: { current: 400, capacity: 400 } });
    const shuttle = makeShip({ symbol: 'SHUTTLE', cargo: { capacity: 40, units: 0, inventory: [] }, fuel: { current: 200, capacity: 200 }, frame: { symbol: 'FRAME_SHUTTLE', condition: 1, integrity: 1 } });
    const hauler = makeShip({ symbol: 'HAULER', cargo: { capacity: 80, units: 0, inventory: [] }, fuel: { current: 300, capacity: 300 }, frame: { symbol: 'FRAME_LIGHT_HAULER', condition: 1, integrity: 1 } });
    expect(pickMineTender([miner, shuttle, hauler])).toBe('HAULER');
    expect(pickMineTender([hauler], { transportPins: ['HAULER'] })).toBeNull();
  });

  it('parses SpaceTraders cooldown text to waited milliseconds', () => {
    expect(parseCooldownMs('Ship action is still on cooldown for 7 seconds.')).toBe(8000);
    expect(parseCooldownMs('no cooldown here')).toBeNull();
  });
});
