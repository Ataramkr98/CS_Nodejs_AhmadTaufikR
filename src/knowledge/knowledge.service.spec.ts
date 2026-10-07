import { chunkText } from './knowledge.service';

describe('chunkText', () => {
  it('keeps all source content while producing bounded overlapping chunks', () => {
    const content = 'A'.repeat(900) + 'B'.repeat(900);
    const chunks = chunkText(content, 800, 120);

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(800);
    expect(chunks[1].startsWith('A'.repeat(120))).toBe(true);
    expect(chunks.at(-1)).toContain('B'.repeat(100));
  });

  it('does not return blank chunks', () => {
    expect(chunkText('   \n\t  ')).toEqual([]);
  });
});
