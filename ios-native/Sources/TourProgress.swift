import Foundation
import Combine

@MainActor
final class TourProgress: ObservableObject {
    static let version = 3
    private struct Record: Codable { var done = false; var step = 0; var pending = false; var claimed: String? }
    @Published private(set) var done = false
    @Published private(set) var step = 0
    @Published private(set) var syncFailed = false
    /// The tour overlay is showing.
    @Published private(set) var active = false
    /// Where the owner was when the tour began, restored when it ends.
    private var origin: (Tab, [Route])?
    private var replaying = false
    private var tenant: String?
    private var revision = 0
    private var record = Record()
    private var posting = false
    private var key: String { "merrymen.native.tour.v\(Self.version)" + (tenant.map { "." + $0 } ?? "") }
    private func read(_ key: String) -> Record {
        guard let data = UserDefaults.standard.data(forKey: key), let value = try? JSONDecoder().decode(Record.self, from: data) else { return Record() }
        return value
    }
    private func write(_ value: Record, key: String) { if let data = try? JSONEncoder().encode(value) { UserDefaults.standard.set(data, forKey: key) } }
    private func save() { write(record, key: key); done = record.done; step = min(25, max(0, record.step)) }
    func activate(_ store: AppStore) async {
        tenant = store.owner?.lowercased(); revision += 1; let current = revision
        record = read(key); syncFailed = false
        if let tenant {
            let anonymousKey = "merrymen.native.tour.v\(Self.version)"
            var anonymous = read(anonymousKey)
            if anonymous.done, anonymous.claimed == nil {
                record.done = true; record.pending = true; anonymous.claimed = tenant; write(anonymous, key: anonymousKey)
            }
        }
        save()
        do {
            let suffix = tenant.map { "?tenant=\(escaped($0))&version=\(Self.version)" } ?? ""
            let state = try await store.api.request("/api/tour" + suffix)
            guard current == revision, !Task.isCancelled else { return }
            if state["done"].bool == true, state["tenant"].string == tenant, state["version"].number == Double(Self.version) {
                record.done = true; record.pending = false; save()
            }
            await sync(store)
        } catch { if current == revision { syncFailed = record.pending } }
    }
    func move(_ step: Int) { record.step = min(25, max(0, step)); save() }
    func begin(_ store: AppStore, replay: Bool) {
        guard !active else { return }
        origin = (store.tab, store.path)
        replaying = replay
        if replay { record.step = 0; save() }
        active = true
    }
    /// The first read can run before the session loads and start the tour for
    /// a "new" guest; once the account's record says it is done, close an
    /// automatic tour without recording anything. A replay stays open.
    func settle(_ store: AppStore) {
        if done { if active && !replaying { restore(store); active = false } }
        else { begin(store, replay: false) }
    }
    private func restore(_ store: AppStore) {
        if let origin { store.path = origin.1; store.tab = origin.0 }
        origin = nil
    }
    func finish(_ store: AppStore) {
        if active { restore(store) }
        active = false; replaying = false
        record.done = true; record.pending = tenant != nil; save()
        Task { await sync(store) }
    }
    func sync(_ store: AppStore) async {
        guard !posting, record.pending, let tenant, store.owner?.lowercased() == tenant else { return }
        posting = true; let current = revision; defer { posting = false }
        do {
            let result = try await store.perform("/api/tour", body: .object(["tenant": .string(tenant), "version": .number(Double(Self.version))]), expectedOwner: store.owner)
            guard current == revision, result["done"].bool == true, result["tenant"].string == tenant else { return }
            record.pending = false; save(); syncFailed = false
        } catch { if current == revision { syncFailed = true } }
    }
}
