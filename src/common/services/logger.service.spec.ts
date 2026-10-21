import { LoggerService } from './logger.service';

describe('LoggerService', () => {
  it('instantiates cleanly and logs messages without errors', () => {
    const service = new LoggerService();
    expect(service).toBeDefined();

    expect(() => {
      service.log('Test message', 'TestContext');
      service.warn('Test warning', 'TestContext');
      service.debug('Test debug', 'TestContext');
    }).not.toThrow();
  });

  it('injects trace_id from active OpenTelemetry span when available', () => {
    const api = require('@opentelemetry/api');
    const mockSpan = {
      spanContext: () => ({
        traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
        spanId: '00f067aa0ba902b7',
        traceFlags: 1,
      }),
    };

    const getActiveSpanSpy = jest
      .spyOn(api.trace, 'getActiveSpan')
      .mockReturnValue(mockSpan as any);

    const service = new LoggerService();
    expect(() => service.log('Telemetry linked message', 'TestContext')).not.toThrow();

    getActiveSpanSpy.mockRestore();
  });
});
