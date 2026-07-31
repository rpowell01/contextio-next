import { test, mock } from 'node:test';

await test('fake timers', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  
  console.log('Time before:', Date.now());
  
  const promise = new Promise(resolve => setTimeout(resolve, 1000));
  mock.timers.tick(1000);
  await promise;
  
  console.log('Time after:', Date.now());
  
  mock.timers.reset();
});