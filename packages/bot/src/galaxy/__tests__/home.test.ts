import { describe, it, expect } from 'vitest';
import { resolveHome, systemOf } from '../home.js';

describe('galaxy/home', () => {
  describe('systemOf', () => {
    it('derives the system from a waypoint symbol', () => {
      expect(systemOf('X1-DB23-A1')).toBe('X1-DB23');
      expect(systemOf('X1-PP30-D18A')).toBe('X1-PP30');
    });
  });

  describe('resolveHome', () => {
    it('derives home system from /my/agent headquarters', async () => {
      const api = async () => ({ data: { headquarters: 'X1-DB23-A1' } });
      const home = await resolveHome(api as never);
      expect(home).toEqual({ homeSystem: 'X1-DB23', hqWaypoint: 'X1-DB23-A1' });
    });

    it('returns null when headquarters is missing', async () => {
      const api = async () => ({ data: { credits: 100 } });
      expect(await resolveHome(api as never)).toBeNull();
    });

    it('returns null when the agent payload is empty', async () => {
      const api = async () => ({});
      expect(await resolveHome(api as never)).toBeNull();
    });

    it('queries /my/agent exactly', async () => {
      let calledPath = '';
      const api = async (_m: string, p: string) => {
        calledPath = p;
        return { data: { headquarters: 'X1-ZZ9-B2' } };
      };
      const home = await resolveHome(api as never);
      expect(calledPath).toBe('/my/agent');
      expect(home?.homeSystem).toBe('X1-ZZ9');
    });
  });
});
