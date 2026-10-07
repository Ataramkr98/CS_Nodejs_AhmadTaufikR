import { HttpStatus } from '@nestjs/common';
import { z } from 'zod';
import { ProblemException, PROBLEM_TYPES } from './problem';

export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ProblemException(
      HttpStatus.BAD_REQUEST,
      'Invalid request',
      'One or more request fields are invalid.',
      PROBLEM_TYPES.validation,
      parsed.error.flatten(),
    );
  }
  return parsed.data;
}

export const paginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
