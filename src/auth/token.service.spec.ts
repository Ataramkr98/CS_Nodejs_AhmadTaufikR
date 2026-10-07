import { JwtService } from '@nestjs/jwt';
import { UserRole } from '@prisma/client';
import { TokenService } from './token.service';

describe('TokenService', () => {
  const config = { get: jest.fn(() => undefined) } as any;
  const service = new TokenService(new JwtService(), config);

  it('issues and verifies RS256 operator tokens', async () => {
    const token = await service.issueOperator({
      id: 'user-1',
      tenantId: 'tenant-1',
      email: 'owner@example.com',
      role: UserRole.OWNER,
    });
    await expect(service.verifyOperator(token)).resolves.toMatchObject({
      sub: 'user-1',
      tenantId: 'tenant-1',
      role: UserRole.OWNER,
      kind: 'operator',
    });
  });

  it('does not accept a visitor token as an operator token', async () => {
    const token = await service.issueVisitor({
      customerId: 'customer-1',
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
    });
    await expect(service.verifyOperator(token)).rejects.toThrow();
  });
});
