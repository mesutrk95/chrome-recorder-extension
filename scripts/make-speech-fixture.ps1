param([Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$meetkeepSynth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $meetkeepSynth.SetOutputToWaveFile($Destination)
  $meetkeepSynth.Speak('Welcome to our project meeting. Today we will review the new design and discuss the next steps. Sarah will finish the report on Friday. Please send your feedback before the next meeting. Thank you everyone for your time.')
} finally {
  $meetkeepSynth.Dispose()
}
