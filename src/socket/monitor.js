export default function startSocketMonitor(io, onlineUsers, intervalMs = 15000) {
  console.log(`[Monitor] Socket & Performance monitoring started (Interval: ${intervalMs / 1000}s)`);
  
  setInterval(() => {
    const memoryUsage = process.memoryUsage();
    
    const formatMem = (bytes) => (bytes / 1024 / 1024).toFixed(2) + ' MB';

    const totalSockets = io.engine.clientsCount;
    const trackedUsers = onlineUsers.size;

    console.log('\n--- [LIVE SOCKET & PERFORMANCE MONITOR] ---');
    console.table({
      'Memory (RSS)': formatMem(memoryUsage.rss),
      'Heap Total': formatMem(memoryUsage.heapTotal),
      'Heap Used': formatMem(memoryUsage.heapUsed),
      'Active Connections': totalSockets,
      'Authenticated Users': trackedUsers
    });
    console.log('-------------------------------------------\n');
  }, intervalMs);
}


