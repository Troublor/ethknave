export interface Service {
    start(): Promise<void>;
    shutdown(): Promise<void>;
}

export class ServiceManager implements Service {
    readonly services: Service[] = [];

    add(service: Service): ServiceManager {
        this.services.push(service);
        return this;
    }

    async start(): Promise<void> {
        for (const s of this.services) {
            await s.start();
        }
    }

    async shutdown(): Promise<void> {
        for (const s of this.services) {
            await s.shutdown();
        }
    }

}
