import { startStubServer } from './stub-server';

export default async function globalSetup(): Promise<() => Promise<void>> {
  const server = startStubServer();
  return async () => {
    server.close();
  };
}
