export default function Schedule() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Schedule</h1>

      <div className="bg-gray-800 rounded-lg p-6">
        <p className="text-gray-400">
          Scheduling features coming soon. You'll be able to:
        </p>
        <ul className="mt-4 space-y-2 text-gray-300">
          <li className="flex items-center gap-2">
            <span className="text-green-400">✓</span>
            Schedule config changes at specific times
          </li>
          <li className="flex items-center gap-2">
            <span className="text-green-400">✓</span>
            Set up recurring events (e.g., "Crazy Mode Fridays")
          </li>
          <li className="flex items-center gap-2">
            <span className="text-green-400">✓</span>
            Reserve server time for private matches
          </li>
          <li className="flex items-center gap-2">
            <span className="text-green-400">✓</span>
            Automatic map rotations
          </li>
        </ul>
      </div>
    </div>
  );
}
