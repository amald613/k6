const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Test configuration
const tests = [
  {
    name: 'Login Test',
    file: 'tests/login.js',
    description: 'Single user login authentication test'
  },
  {
    name: 'Create User Test',
    file: 'tests/create-user.js',
    description: 'User creation endpoint load test'
  },
  {
    name: 'List Users Test',
    file: 'tests/list-users.js',
    description: 'Admin list users endpoint load test'
  }
];

// Results storage
const results = [];
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

// Create reports directory if it doesn't exist
const reportDir = 'reports';
if (!fs.existsSync(reportDir)) {
  fs.mkdirSync(reportDir, { recursive: true });
  console.log('📁 Created reports directory\n');
}

console.log('\n🚀 Starting k6 Test Suite...\n');
console.log('═'.repeat(60));

// Run each test
tests.forEach((test, index) => {
  console.log(`\n📋 Test ${index + 1}/${tests.length}: ${test.name}`);
  console.log('─'.repeat(60));
  
  const startTime = Date.now();
  const outputFile = `reports/raw-${index + 1}-${path.basename(test.file, '.js')}.json`;
  
  try {
    // Run k6 with JSON output
    const command = `k6 run --out json=${outputFile} ${test.file}`;
    console.log(`▶️  Running: ${command}\n`);
    
    const output = execSync(command, { 
      encoding: 'utf-8',
      stdio: 'inherit'
    });
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    
    // Parse the JSON output if file exists
    let metrics = null;
    if (fs.existsSync(outputFile)) {
      try {
        const jsonData = fs.readFileSync(outputFile, 'utf-8')
          .split('\n')
          .filter(line => line.trim())
          .map(line => JSON.parse(line));
        
        // Extract metrics
        metrics = extractMetrics(jsonData);
      } catch (parseError) {
        console.log(`⚠️  Warning: Could not parse metrics from ${outputFile}`);
      }
    }
    
    results.push({
      name: test.name,
      file: test.file,
      description: test.description,
      status: 'PASSED',
      duration: duration,
      metrics: metrics,
      timestamp: new Date().toISOString()
    });
    
    console.log(`✅ ${test.name} completed in ${duration}s\n`);
    
  } catch (error) {
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    
    results.push({
      name: test.name,
      file: test.file,
      description: test.description,
      status: 'FAILED',
      duration: duration,
      error: error.message,
      timestamp: new Date().toISOString()
    });
    
    console.log(`❌ ${test.name} failed in ${duration}s\n`);
  }
});

console.log('\n═'.repeat(60));
console.log('📊 Generating HTML Report...\n');

// Generate HTML report
generateHTMLReport(results, timestamp);

console.log('✅ All tests completed!');
console.log(`📄 Report saved to: reports/test-report-${timestamp}.html\n`);

// Helper function to extract metrics from k6 JSON output
function extractMetrics(jsonData) {
  const metrics = {
    http_reqs: 0,
    http_req_duration: { avg: 0, min: 0, max: 0, p95: 0 },
    http_req_failed: 0,
    iterations: 0,
    checks: { total: 0, passed: 0, failed: 0 },
    vus_max: 0
  };
  
  jsonData.forEach(entry => {
    if (entry.type === 'Metric') {
      const metricName = entry.metric;
      const value = entry.data.value;
      
      if (metricName === 'http_reqs' && entry.data.type === 'counter') {
        metrics.http_reqs++;
      } else if (metricName === 'http_req_duration') {
        if (!metrics.http_req_duration.values) {
          metrics.http_req_duration.values = [];
        }
        metrics.http_req_duration.values.push(value);
      } else if (metricName === 'http_req_failed' && value > 0) {
        metrics.http_req_failed++;
      } else if (metricName === 'iterations') {
        metrics.iterations++;
      } else if (metricName === 'checks' && entry.data.type === 'rate') {
        metrics.checks.total++;
        if (value === 1) metrics.checks.passed++;
        else metrics.checks.failed++;
      } else if (metricName === 'vus_max') {
        metrics.vus_max = Math.max(metrics.vus_max, value);
      }
    }
  });
  
  // Calculate duration stats
  if (metrics.http_req_duration.values && metrics.http_req_duration.values.length > 0) {
    const values = metrics.http_req_duration.values.sort((a, b) => a - b);
    metrics.http_req_duration.avg = (values.reduce((a, b) => a + b, 0) / values.length).toFixed(2);
    metrics.http_req_duration.min = values[0].toFixed(2);
    metrics.http_req_duration.max = values[values.length - 1].toFixed(2);
    metrics.http_req_duration.p95 = values[Math.floor(values.length * 0.95)].toFixed(2);
  }
  
  return metrics;
}

// Generate HTML report
function generateHTMLReport(results, timestamp) {
  const reportDir = 'reports';
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }
  
  const totalTests = results.length;
  const passedTests = results.filter(r => r.status === 'PASSED').length;
  const failedTests = results.filter(r => r.status === 'FAILED').length;
  const totalDuration = results.reduce((sum, r) => sum + parseFloat(r.duration), 0).toFixed(2);
  
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>k6 Test Report - ${timestamp}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            padding: 20px;
            line-height: 1.6;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
            background: white;
            border-radius: 12px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            overflow: hidden;
        }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 40px;
            text-align: center;
        }
        .header h1 {
            font-size: 2.5em;
            margin-bottom: 10px;
            font-weight: 700;
        }
        .header p {
            font-size: 1.1em;
            opacity: 0.9;
        }
        .summary {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            padding: 40px;
            background: #f8f9fa;
        }
        .summary-card {
            background: white;
            padding: 25px;
            border-radius: 10px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            text-align: center;
            transition: transform 0.2s;
        }
        .summary-card:hover {
            transform: translateY(-5px);
            box-shadow: 0 5px 20px rgba(0,0,0,0.15);
        }
        .summary-card .value {
            font-size: 2.5em;
            font-weight: 700;
            margin: 10px 0;
        }
        .summary-card .label {
            color: #666;
            font-size: 0.9em;
            text-transform: uppercase;
            letter-spacing: 1px;
        }
        .success { color: #10b981; }
        .failure { color: #ef4444; }
        .info { color: #3b82f6; }
        .warning { color: #f59e0b; }
        
        .test-results {
            padding: 40px;
        }
        .test-card {
            background: white;
            border: 1px solid #e5e7eb;
            border-radius: 10px;
            padding: 25px;
            margin-bottom: 20px;
            transition: all 0.3s;
        }
        .test-card:hover {
            box-shadow: 0 5px 20px rgba(0,0,0,0.1);
        }
        .test-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
            padding-bottom: 15px;
            border-bottom: 2px solid #f3f4f6;
        }
        .test-title {
            font-size: 1.5em;
            font-weight: 600;
            color: #1f2937;
        }
        .status-badge {
            padding: 8px 16px;
            border-radius: 20px;
            font-weight: 600;
            font-size: 0.9em;
            text-transform: uppercase;
        }
        .status-passed {
            background: #d1fae5;
            color: #065f46;
        }
        .status-failed {
            background: #fee2e2;
            color: #991b1b;
        }
        .test-meta {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-top: 20px;
        }
        .meta-item {
            display: flex;
            flex-direction: column;
        }
        .meta-label {
            font-size: 0.85em;
            color: #6b7280;
            margin-bottom: 5px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .meta-value {
            font-size: 1.1em;
            font-weight: 600;
            color: #1f2937;
        }
        .metrics-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 15px;
            margin-top: 20px;
            padding-top: 20px;
            border-top: 1px solid #e5e7eb;
        }
        .metric {
            text-align: center;
            padding: 15px;
            background: #f9fafb;
            border-radius: 8px;
        }
        .metric-value {
            font-size: 1.5em;
            font-weight: 700;
            color: #3b82f6;
        }
        .metric-label {
            font-size: 0.8em;
            color: #6b7280;
            margin-top: 5px;
        }
        .footer {
            text-align: center;
            padding: 30px;
            background: #f8f9fa;
            color: #666;
            font-size: 0.9em;
        }
        .error-message {
            background: #fee2e2;
            border-left: 4px solid #ef4444;
            padding: 15px;
            margin-top: 15px;
            border-radius: 5px;
            color: #991b1b;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🚀 k6 Performance Test Report</h1>
            <p>Generated on ${new Date(timestamp).toLocaleString()}</p>
        </div>
        
        <div class="summary">
            <div class="summary-card">
                <div class="label">Total Tests</div>
                <div class="value info">${totalTests}</div>
            </div>
            <div class="summary-card">
                <div class="label">Passed</div>
                <div class="value success">${passedTests}</div>
            </div>
            <div class="summary-card">
                <div class="label">Failed</div>
                <div class="value failure">${failedTests}</div>
            </div>
            <div class="summary-card">
                <div class="label">Total Duration</div>
                <div class="value warning">${totalDuration}s</div>
            </div>
        </div>
        
        <div class="test-results">
            <h2 style="margin-bottom: 30px; color: #1f2937; font-size: 2em;">Test Results</h2>
            
            ${results.map(test => `
                <div class="test-card">
                    <div class="test-header">
                        <div class="test-title">${test.name}</div>
                        <div class="status-badge status-${test.status.toLowerCase()}">${test.status}</div>
                    </div>
                    
                    <p style="color: #6b7280; margin-bottom: 15px;">${test.description}</p>
                    
                    <div class="test-meta">
                        <div class="meta-item">
                            <span class="meta-label">Test File</span>
                            <span class="meta-value">${test.file}</span>
                        </div>
                        <div class="meta-item">
                            <span class="meta-label">Duration</span>
                            <span class="meta-value">${test.duration}s</span>
                        </div>
                        <div class="meta-item">
                            <span class="meta-label">Timestamp</span>
                            <span class="meta-value">${new Date(test.timestamp).toLocaleTimeString()}</span>
                        </div>
                    </div>
                    
                    ${test.status === 'PASSED' && test.metrics ? `
                        <div class="metrics-grid">
                            <div class="metric">
                                <div class="metric-value">${test.metrics.http_reqs}</div>
                                <div class="metric-label">HTTP Requests</div>
                            </div>
                            <div class="metric">
                                <div class="metric-value">${test.metrics.iterations}</div>
                                <div class="metric-label">Iterations</div>
                            </div>
                            <div class="metric">
                                <div class="metric-value">${test.metrics.http_req_duration.avg}ms</div>
                                <div class="metric-label">Avg Duration</div>
                            </div>
                            <div class="metric">
                                <div class="metric-value">${test.metrics.http_req_duration.p95}ms</div>
                                <div class="metric-label">P95 Duration</div>
                            </div>
                            <div class="metric">
                                <div class="metric-value">${test.metrics.checks.passed}/${test.metrics.checks.total}</div>
                                <div class="metric-label">Checks Passed</div>
                            </div>
                            <div class="metric">
                                <div class="metric-value">${test.metrics.vus_max}</div>
                                <div class="metric-label">Max VUs</div>
                            </div>
                        </div>
                    ` : ''}
                    
                    ${test.error ? `
                        <div class="error-message">
                            <strong>Error:</strong> ${test.error}
                        </div>
                    ` : ''}
                </div>
            `).join('')}
        </div>
        
        <div class="footer">
            <p>Generated by k6 Test Runner | API Performance Testing Suite</p>
        </div>
    </div>
</body>
</html>`;
  
  fs.writeFileSync(`${reportDir}/test-report-${timestamp}.html`, html);
}