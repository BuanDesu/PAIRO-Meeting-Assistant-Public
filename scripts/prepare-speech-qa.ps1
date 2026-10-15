$ErrorActionPreference = 'Stop'
$taskQaDirectory = Join-Path (Split-Path $PSScriptRoot -Parent) 'release/xp-qa'
New-Item -ItemType Directory -Force -Path $taskQaDirectory | Out-Null
Add-Type -AssemblyName System.Speech
$taskSynth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $taskVoice = $taskSynth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq 'en-US' } | Select-Object -First 1
    if ($taskVoice) { $taskSynth.SelectVoice($taskVoice.VoiceInfo.Name) }
    $taskFormat = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
    $taskSynth.SetOutputToWaveFile((Join-Path $taskQaDirectory 'generated-speech.wav'), $taskFormat)
    $taskSynth.Speak('This is a local meeting assistant. Please explain the next steps clearly.')
} finally { $taskSynth.Dispose() }
