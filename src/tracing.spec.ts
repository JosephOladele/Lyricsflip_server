import { initOpenTelemetry, getTracer, getActiveTraceId } from './tracing';

describe('Tracing Module', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('runs as a no-op when OTEL_EXPORTER_OTLP_ENDPOINT is not set', () => {
    expect(() => initOpenTelemetry()).not.toThrow();
  });

  it('provides a tracer that can start spans safely', () => {
    const tracer = getTracer('test-tracer');
    expect(tracer).toBeDefined();

    let executed = false;
    tracer.startActiveSpan('test-span', (span: any) => {
      span.setAttribute('test.attr', 'value');
      span.end();
      executed = true;
    });

    expect(executed).toBe(true);
  });

  it('returns undefined for active trace id when no active trace exists', () => {
    expect(getActiveTraceId()).toBeUndefined();
  });
});
