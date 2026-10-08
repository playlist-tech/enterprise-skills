import { describe, it, expect } from 'vitest';
import { parseSkillsField } from '../src/skills-field.ts';

describe('parseSkillsField', () => {
  it('parses npm: strings and objects', () => {
    expect(
      parseSkillsField(
        ['npm:@vueuse/skills', { source: 'npm:my-lib', skills: ['a', 'b'] }],
        'my-pack'
      )
    ).toEqual({
      npm: [
        { package: '@vueuse/skills', skills: [] },
        { package: 'my-lib', skills: ['a', 'b'] },
      ],
      errors: [],
    });
  });

  it('skips remote entries', () => {
    expect(
      parseSkillsField(['owner/repo@skill', { source: 'owner/repo', ref: 'v1' }, 'npm:x'], '.')
    ).toEqual({ npm: [{ package: 'x', skills: [] }], errors: [] });
  });

  it('rejects ref on an npm: entry', () => {
    expect(parseSkillsField([{ source: 'npm:x', ref: 'v1' }], 'my-pack').errors).toEqual([
      'my-pack: "ref" cannot be used with "npm:x"',
    ]);
  });

  it('rejects malformed entries and keeps the valid ones', () => {
    const parsed = parseSkillsField(
      [42, { skills: ['a'] }, { source: 'npm:x', skills: 'a' }, 'npm:ok'],
      '.'
    );
    expect(parsed.errors).toEqual([
      '.: invalid "skills" entry 42',
      '.: invalid "skills" entry {"skills":["a"]}',
      '.: invalid "skills" entry {"source":"npm:x","skills":"a"}',
    ]);
    expect(parsed.npm).toEqual([{ package: 'ok', skills: [] }]);
  });
});
