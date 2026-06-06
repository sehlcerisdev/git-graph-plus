import { describe, it, expect } from 'vitest';
import { resolveDefaults } from '../defaults.svelte';
import { DEFAULT_MODAL_DEFAULTS } from '../../defaults-shape';

describe('resolveDefaults', () => {
  it('returns the hardcoded defaults when given nothing', () => {
    expect(resolveDefaults(undefined)).toEqual(DEFAULT_MODAL_DEFAULTS);
  });

  it('fills missing fields in a partial modal object from fallbacks', () => {
    const out = resolveDefaults({ push: { force: 'force' } } as any);
    expect(out.push).toEqual({ force: 'force', setUpstream: true, allTags: false });
  });

  it('rejects an invalid enum value and falls back to the default', () => {
    const out = resolveDefaults({ reset: { mode: 'nuke' } } as any);
    expect(out.reset.mode).toBe('mixed');
  });

  it('coerces non-boolean values to the fallback boolean', () => {
    const out = resolveDefaults({ pull: { rebase: 'yes' } } as any);
    expect(out.pull.rebase).toBe(true); // fallback, not truthy-coerced
  });

  it('ignores unknown modal keys', () => {
    const out = resolveDefaults({ bogus: { x: 1 } } as any);
    expect(out).toEqual(DEFAULT_MODAL_DEFAULTS);
  });
});
