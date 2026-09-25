import AVFoundation
import Speech
import Combine

/// On-device dictation produces an editable draft. It never sends a chat
/// message or authorizes a command, and never falls back to network recognition.
@MainActor
final class VoiceDraft: ObservableObject {
    @Published private(set) var recording = false
    @Published private(set) var starting = false
    @Published private(set) var transcript = ""
    @Published var error: String?
    private var engine: AVAudioEngine?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var recognition: SFSpeechRecognitionTask?
    private var deadline: Task<Void, Never>?
    private var runID: UUID?

    func start(locale: String) async {
        guard !starting, !recording else { return }
        let id = UUID(); runID = id; starting = true; error = nil; transcript = ""
        defer { starting = false }
        let speech = await withCheckedContinuation { continuation in SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) } }
        guard runID == id else { return }
        guard speech == .authorized else { error = "Allow speech recognition in iOS Settings to dictate a draft."; return }
        let microphone = await withCheckedContinuation { continuation in AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) } }
        guard runID == id else { return }
        guard microphone else { error = "Allow microphone access in iOS Settings to dictate a draft."; return }
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)), recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else {
            error = "On-device dictation is unavailable for this language. You can type your message instead."; return
        }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            let engine = AVAudioEngine()
            let format = engine.inputNode.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else { throw APIError(status: 0, message: "The microphone is unavailable.") }
            let request = SFSpeechAudioBufferRecognitionRequest()
            request.requiresOnDeviceRecognition = true; request.shouldReportPartialResults = true
            request.taskHint = .dictation
            self.engine = engine; self.request = request
            engine.inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in request.append(buffer) }
            recognition = recognizer.recognitionTask(with: request) { [weak self] result, failure in
                let text = result?.bestTranscription.formattedString
                let final = result?.isFinal == true
                Task { @MainActor in
                    guard let self, self.runID == id else { return }
                    if let text { self.transcript = text }
                    if failure != nil || final {
                        self.stop()
                        if failure != nil, self.transcript.isEmpty { self.error = "Dictation stopped without a transcript. Try again or type your message." }
                    }
                }
            }
            engine.prepare(); try engine.start(); recording = true
            deadline = Task { @MainActor [weak self] in
                do { try await Task.sleep(for: .seconds(55)) } catch { return }
                self?.stop()
            }
        } catch { stop(); self.error = error.localizedDescription }
    }

    func stop() {
        runID = nil; deadline?.cancel(); deadline = nil
        if let engine { engine.stop(); engine.inputNode.removeTap(onBus: 0) }
        request?.endAudio(); recognition?.cancel()
        recognition = nil; request = nil; engine = nil; recording = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
