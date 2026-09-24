import SwiftUI
import JavaScriptCore

@MainActor
final class FeedPresentation: ObservableObject {
    private let context: JSContext?
    init() {
        context = JSContext()
        if let url = Bundle.main.url(forResource: "FeedEngine", withExtension: "js"), let source = try? String(contentsOf: url, encoding: .utf8) { context?.evaluateScript(source) }
    }
    func rows(_ input: J) -> [J]? {
        value(input, function: "render")?.array
    }
    func profile(_ input: J) -> J? { value(input, function: "profile") }
    private func value(_ input: J, function: String) -> J? {
        guard let context, context.exception == nil, let data = try? JSONEncoder().encode(input),
              let result = context.objectForKeyedSubscript("NativeFeed")?.objectForKeyedSubscript(function)?.call(withArguments: [String(decoding: data, as: UTF8.self)])?.toString(),
              let value = try? JSONDecoder().decode(J.self, from: Data(result.utf8)) else { return nil }
        return value
    }
}

struct FeedBeatCard: View {
    @EnvironmentObject var store: AppStore
    let beat: J
    @State private var members: ReviewValue?
    var body: some View { Card {
        HStack {
            Avatar(slug: beat["actor"]["slug"].string)
            NavigationLink(beat["actor"]["name"].text, value: Route.agent(beat["actor"]["slug"].text)).font(.headline)
            Spacer()
            if let time = beat["atMs"].number { Text(Date(timeIntervalSince1970: time / 1000), style: .relative).font(.caption).foregroundStyle(.secondary) }
        }
        Text(beat["title"].text).font(.title3.bold())
        if let post = beat["post"].string, !post.isEmpty {
            Text(post).textSelection(.enabled)
            if !beat["reason"].text.isEmpty { DisclosureGroup("Why") { Text(beat["reason"].text).textSelection(.enabled) } }
        } else if !beat["reason"].text.isEmpty { Text(beat["reason"].text).textSelection(.enabled) }
        HStack {
            if beat["paper"].bool == true { Text("PAPER").font(.caption.bold()).foregroundStyle(.orange) }
            if beat["shadow"].bool == true { Text("Unexecuted view").font(.caption).foregroundStyle(.secondary) }
            Text(beat["outcomeText"].string ?? beat["badge"].string ?? "Analysis").font(.caption).foregroundStyle(.secondary)
        }
        if let count = beat["said"].number, count > 1 {
            HStack { Text("Said \(Int(count)) times"); if let since = beat["sinceMs"].number { Text("· unchanged since"); Text(Date(timeIntervalSince1970: since / 1000), style: .relative) } }.font(.caption).foregroundStyle(.secondary)
        }
        if !beat["members"].array.isEmpty { Button("Read each agent's view") { members = ReviewValue(value: beat["members"]) } }
        Rows(values: beat["mentions"].array) { mention in NavigationLink("Mentioned \(mention["name"].text)", value: Route.agent(mention["slug"].text)).font(.caption) }
        HStack {
            if let id = beat["postId"].string {
                Button { Task { await store.toggleLike(id) } } label: {
                    Label(beat["count"].number.map { String(Int($0)) } ?? "—", systemImage: store.likes.contains(id) ? "heart.fill" : "heart")
                }.disabled(store.owner == nil).accessibilityLabel(store.likes.contains(id) ? "Unlike thesis" : "Like thesis")
            }
            Spacer()
            if let slug = beat["actor"]["slug"].string, let url = URL(string: "https://app.merrymen.dev/a/\(escaped(slug))") { ShareLink(item: url).labelStyle(.iconOnly) }
        }
    }.sheet(item: $members) { selected in NavigationStack { Page { Rows(values: selected.value.array) { FeedBeatCard(beat: $0) } }.navigationTitle("Agent views").toolbar { Button("Done") { members = nil } } } } }
}
