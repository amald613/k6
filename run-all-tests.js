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
  },
  {
    name: 'Ban and Unban Users Test',
    file: 'tests/ban-unban-users.js',
    description: 'Ban and Unban users endpoint load test'
  },
  {
    name: 'Set Role Test',
    file: 'tests/set-role.js',
    description: 'Set Role endpoint load test'
  },
  {
    name: 'Edit Users Test',
    file: 'tests/edit-user.js',
    description: 'Edit users endpoint load test'
  }
];

// Results storage
const results = [];
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

// Create reports directory
const reportDir = 'reports';
if (!fs.existsSync(reportDir)) {
  fs.mkdirSync(reportDir, { recursive: true });
}

console.log('\n🚀 Starting k6 Test Suite...\n');
console.log('═'.repeat(60));

// Run each test
tests.forEach((test, index) => {
  console.log(`\n📋 Test ${index + 1}/${tests.length}: ${test.name}`);
  console.log('─'.repeat(60));
  
  const startTime = Date.now();
  const summaryFile = `reports/summary-${index + 1}-${path.basename(test.file, '.js')}.json`;
  
  try {
    // Run k6 with summary export
    const command = `k6 run --summary-export=${summaryFile} ${test.file}`;
    console.log(`▶️  Running: ${test.file}\n`);
    
    // Capture the console output to parse metrics
    const output = execSync(command, { 
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'inherit'] // Capture stdout, inherit stderr
    });
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    
    // Parse metrics from the console output
    const metrics = parseMetricsFromOutput(output, test.name);
    
    results.push({
      name: test.name,
      file: test.file,
      description: test.description,
      status: 'PASSED',
      duration: duration,
      metrics: metrics,
      timestamp: new Date().toISOString()
    });
    
    console.log(`✅ ${test.name} completed in ${duration}s`);
    console.log(`📊 ${metrics.http_reqs} requests | ${metrics.http_req_duration.avg}ms avg | ${metrics.checks.rate}% success`);
    
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
    
    console.log(`❌ ${test.name} failed in ${duration}s`);
  }
});

console.log('\n═'.repeat(60));
console.log('📊 Generating HTML Report...\n');

// Generate HTML report
generateHTMLReport(results, timestamp);

// Generate CSV
exportToCSV(results, timestamp);

console.log('✅ All tests completed!');
console.log(`📄 Report saved to: reports/test-report-${timestamp}.html\n`);

// Final summary
const totalTests = results.length;
const passedTests = results.filter(r => r.status === 'PASSED').length;
const failedTests = results.filter(r => r.status === 'FAILED').length;

console.log('📈 Summary:');
console.log(`   Total Tests: ${totalTests}`);
console.log(`   ✅ Passed: ${passedTests}`);
console.log(`   ❌ Failed: ${failedTests}`);
console.log(`   Success Rate: ${((passedTests / totalTests) * 100).toFixed(1)}%\n`);

// Parse metrics from k6 console output
function parseMetricsFromOutput(output, testName) {
  const metrics = {
    http_reqs: 0,
    http_req_duration: { avg: 0, min: 0, max: 0, p95: 0, med: 0 },
    http_req_failed: 0,
    http_req_failed_rate: 0,
    iterations: 0,
    checks: { total: 0, passed: 0, failed: 0, rate: 0 },
    vus_max: 0,
    data_received: '0 B',
    data_sent: '0 B'
  };

  try {
    const lines = output.split('\n');
    
    // Parse HTTP metrics
    const httpReqsMatch = output.match(/http_reqs[^:]*:\s*([\d,]+)/);
    if (httpReqsMatch) metrics.http_reqs = parseInt(httpReqsMatch[1].replace(/,/g, '')) || 0;
    
    const iterationsMatch = output.match(/iterations[^:]*:\s*([\d,]+)/);
    if (iterationsMatch) metrics.iterations = parseInt(iterationsMatch[1].replace(/,/g, '')) || 0;
    
    const checksMatch = output.match(/checks[^:]*:\s*([\d.]+)%/);
    if (checksMatch) metrics.checks.rate = parseFloat(checksMatch[1]) || 0;
    
    // Parse duration metrics
    const avgDurationMatch = output.match(/http_req_duration[^:]*:\s*avg=([\d.]+)/);
    if (avgDurationMatch) metrics.http_req_duration.avg = parseFloat(avgDurationMatch[1]) || 0;
    
    const minDurationMatch = output.match(/min=([\d.]+)/);
    if (minDurationMatch) metrics.http_req_duration.min = parseFloat(minDurationMatch[1]) || 0;
    
    const maxDurationMatch = output.match(/max=([\d.]+)/);
    if (maxDurationMatch) metrics.http_req_duration.max = parseFloat(maxDurationMatch[1]) || 0;
    
    const medDurationMatch = output.match(/med=([\d.]+)/);
    if (medDurationMatch) metrics.http_req_duration.med = parseFloat(medDurationMatch[1]) || 0;
    
    const p95DurationMatch = output.match(/p\(95\)=([\d.]+)/);
    if (p95DurationMatch) metrics.http_req_duration.p95 = parseFloat(p95DurationMatch[1]) || 0;
    
    // Parse failure rate
    const failedMatch = output.match(/http_req_failed[^:]*:\s*([\d.]+)%/);
    if (failedMatch) metrics.http_req_failed_rate = parseFloat(failedMatch[1]) || 0;
    
    const failedCountMatch = output.match(/http_req_failed[^:]*:\s*([\d,]+)\s*/);
    if (failedCountMatch) metrics.http_req_failed = parseInt(failedCountMatch[1].replace(/,/g, '')) || 0;
    
    // Parse VUs
    const vusMatch = output.match(/vus_max[^:]*:\s*([\d,]+)/);
    if (vusMatch) metrics.vus_max = parseInt(vusMatch[1].replace(/,/g, '')) || 0;
    
    // Parse data transfer
    const dataReceivedMatch = output.match(/data_received[^:]*:\s*([\d.]+\s*\w+)/);
    if (dataReceivedMatch) metrics.data_received = dataReceivedMatch[1].trim();
    
    const dataSentMatch = output.match(/data_sent[^:]*:\s*([\d.]+\s*\w+)/);
    if (dataSentMatch) metrics.data_sent = dataSentMatch[1].trim();
    
    // Parse checks counts
    const checksPassedMatch = output.match(/checks[^:]*:\s*([\d,]+)\s*of/);
    const checksTotalMatch = output.match(/checks[^:]*:\s*[\d,]+\s*of\s*([\d,]+)/);
    
    if (checksPassedMatch && checksTotalMatch) {
      metrics.checks.passed = parseInt(checksPassedMatch[1].replace(/,/g, '')) || 0;
      metrics.checks.total = parseInt(checksTotalMatch[1].replace(/,/g, '')) || 0;
      metrics.checks.failed = metrics.checks.total - metrics.checks.passed;
    }
    
  } catch (error) {
    console.log(`⚠️  Error parsing metrics for ${testName}: ${error.message}`);
  }
  
  return metrics;
}

function exportToCSV(results, timestamp) {
  const csvHeaders = 'Test Name,Status,Duration(s),Iterations,HTTP Requests,Avg Response Time(ms),P95 Response Time(ms),Success Rate(%),Fail Rate(%),Timestamp\n';
  const csvRows = results.map(test => 
    `"${test.name}",${test.status},${test.duration},${test.metrics.iterations},${test.metrics.http_reqs},${test.metrics.http_req_duration.avg},${test.metrics.http_req_duration.p95},${test.metrics.checks.rate},${test.metrics.http_req_failed_rate},${test.timestamp}`
  ).join('\n');
  
  const csvContent = csvHeaders + csvRows;
  fs.writeFileSync(`${reportDir}/test-results-${timestamp}.csv`, csvContent);
}

function generateHTMLReport(results, timestamp) {
  const totalTests = results.length;
  const passedTests = results.filter(r => r.status === 'PASSED').length;
  const failedTests = results.filter(r => r.status === 'FAILED').length;
  const totalDuration = results.reduce((sum, r) => sum + parseFloat(r.duration), 0).toFixed(2);
  const successRate = ((passedTests / totalTests) * 100).toFixed(1);

  // Calculate overall metrics
  let totalRequests = 0;
  let totalIterations = 0;
  let avgResponseTime = 0;
  let testCount = 0;

  results.forEach(test => {
    if (test.metrics) {
      totalRequests += test.metrics.http_reqs;
      totalIterations += test.metrics.iterations;
      avgResponseTime += parseFloat(test.metrics.http_req_duration.avg);
      testCount++;
    }
  });

  avgResponseTime = testCount > 0 ? (avgResponseTime / testCount).toFixed(2) : 0;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>k6 Test Report - ${timestamp}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #f5f6fa;
            padding: 20px;
            line-height: 1.6;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
            background: white;
            border-radius: 10px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.1);
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
        }
        .summary {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            padding: 30px;
            background: #f8f9fa;
        }
        .summary-card {
            background: white;
            padding: 25px;
            border-radius: 8px;
            text-align: center;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        .summary-card .value {
            font-size: 2em;
            font-weight: bold;
            margin: 10px 0;
        }
        .success { color: #10b981; }
        .failure { color: #ef4444; }
        .info { color: #3b82f6; }
        
        .overview {
            padding: 30px;
            background: white;
            border-bottom: 1px solid #e5e7eb;
        }
        .overview h2 {
            margin-bottom: 20px;
            color: #1f2937;
        }
        .overview-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
        }
        .overview-item {
            padding: 15px;
            background: #f8f9fa;
            border-radius: 8px;
        }
        .overview-item .label {
            font-size: 0.9em;
            color: #6b7280;
            margin-bottom: 5px;
        }
        .overview-item .value {
            font-size: 1.2em;
            font-weight: 600;
            color: #1f2937;
        }
        
        .test-results {
            padding: 30px;
        }
        .test-card {
            background: white;
            border: 1px solid #e5e7eb;
            border-radius: 8px;
            padding: 25px;
            margin-bottom: 20px;
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
            font-size: 1.3em;
            font-weight: 600;
            color: #1f2937;
        }
        .status-badge {
            padding: 6px 12px;
            border-radius: 20px;
            font-weight: 600;
            font-size: 0.8em;
        }
        .status-passed {
            background: #d1fae5;
            color: #065f46;
        }
        .status-failed {
            background: #fee2e2;
            color: #991b1b;
        }
        .test-metrics {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 15px;
            margin-top: 15px;
        }
        .metric {
            text-align: center;
            padding: 10px;
            background: #f9fafb;
            border-radius: 6px;
        }
        .metric-value {
            font-size: 1.4em;
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
            padding: 20px;
            background: #f8f9fa;
            color: #666;
        }
        .error {
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
            <p>Generated on ${new Date().toLocaleString()}</p>
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
                <div class="label">Success Rate</div>
                <div class="value ${successRate >= 90 ? 'success' : 'failure'}">${successRate}%</div>
            </div>
        </div>
        
        <div class="overview">
            <h2>📊 Overall Performance</h2>
            <div class="overview-grid">
                <div class="overview-item">
                    <div class="label">Total HTTP Requests</div>
                    <div class="value">${totalRequests}</div>
                </div>
                <div class="overview-item">
                    <div class="label">Total Iterations</div>
                    <div class="value">${totalIterations}</div>
                </div>
                <div class="overview-item">
                    <div class="label">Average Response Time</div>
                    <div class="value">${avgResponseTime}ms</div>
                </div>
                <div class="overview-item">
                    <div class="label">Total Duration</div>
                    <div class="value">${totalDuration}s</div>
                </div>
            </div>
        </div>
        
        <div class="test-results">
            <h2 style="margin-bottom: 20px; color: #1f2937;">Detailed Test Results</h2>
            
            ${results.map(test => `
                <div class="test-card">
                    <div class="test-header">
                        <div class="test-title">${test.name}</div>
                        <div class="status-badge status-${test.status.toLowerCase()}">${test.status}</div>
                    </div>
                    
                    <p style="color: #6b7280;">${test.description}</p>
                    <p style="color: #6b7280; font-size: 0.9em; margin-top: 5px;">File: ${test.file} | Duration: ${test.duration}s</p>
                    
                    ${test.status === 'PASSED' ? `
                        <div class="test-metrics">
                            <div class="metric">
                                <div class="metric-value">${test.metrics.iterations}</div>
                                <div class="metric-label">Iterations</div>
                            </div>
                            <div class="metric">
                                <div class="metric-value">${test.metrics.http_reqs}</div>
                                <div class="metric-label">HTTP Requests</div>
                            </div>
                            <div class="metric">
                                <div class="metric-value">${test.metrics.http_req_duration.avg}ms</div>
                                <div class="metric-label">Avg Response Time</div>
                            </div>
                            <div class="metric">
                                <div class="metric-value">${test.metrics.http_req_duration.p95}ms</div>
                                <div class="metric-label">P95 Response Time</div>
                            </div>
                            <div class="metric">
                                <div class="metric-value" style="color: ${test.metrics.checks.rate >= 95 ? '#10b981' : '#ef4444'}">${test.metrics.checks.rate}%</div>
                                <div class="metric-label">Success Rate</div>
                            </div>
                            <div class="metric">
                                <div class="metric-value">${test.metrics.http_req_failed_rate}%</div>
                                <div class="metric-label">Fail Rate</div>
                            </div>
                        </div>
                        
                        <div style="margin-top: 15px; display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; font-size: 0.9em; color: #6b7280;">
                            <div><strong>Duration Details:</strong> Min: ${test.metrics.http_req_duration.min}ms, Med: ${test.metrics.http_req_duration.med}ms, Max: ${test.metrics.http_req_duration.max}ms</div>
                            <div><strong>Data:</strong> Received: ${test.metrics.data_received}, Sent: ${test.metrics.data_sent}</div>
                            <div><strong>VUs:</strong> Max: ${test.metrics.vus_max}</div>
                            <div><strong>Checks:</strong> ${test.metrics.checks.passed}/${test.metrics.checks.total} passed</div>
                        </div>
                    ` : ''}
                    
                    ${test.error ? `
                        <div class="error">
                            <strong>❌ Error:</strong> ${test.error}
                        </div>
                    ` : ''}
                </div>
            `).join('')}
        </div>
        
        <div class="footer">
            <p>Generated by k6 Test Runner | ${new Date().toLocaleString()}</p>
        </div>
    </div>
</body>
</html>`;

  const reportFile = `${reportDir}/test-report-${timestamp}.html`;
  fs.writeFileSync(reportFile, html);
  console.log(`✅ HTML report generated: ${reportFile}`);
}