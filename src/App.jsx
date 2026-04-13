import React, { useState } from 'react';
import { ... } from '...'; // other imports

const App = () => {
    const [slotFill, setSlotFill] = useState([...]); // existing state
    const [showBallDistribution, setShowBallDistribution] = useState(false);

    const sumLandings = slotFill.reduce((acc, curr) => acc + curr, 0);

    return (
        <div className="app">
            <Settings>
                <div className="settings-row">
                    <label>Ball Distribution</label>
                    <button onClick={() => setShowBallDistribution(!showBallDistribution)}>
                        {showBallDistribution ? 'Hide' : 'Show'}
                    </button>
                </div>
                {showBallDistribution && (
                    <table className="distribution-table">
                        <thead>
                            <tr>
                                <th>Slot</th>
                                <th>Total</th>
                                <th>%</th>
                            </tr>
                        </thead>
                        <tbody>
                            {slotFill.map((count, index) => (
                                <tr key={index}>
                                    <td>S{index + 1}</td>
                                    <td>{count}</td>
                                    <td>{sumLandings > 0 ? ((count / sumLandings) * 100).toFixed(2) : 0}%</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
                <div className="settings-row">
                    <span>Overall Total Landings: {sumLandings}</span>
                </div>
            </Settings>
            {/* existing UI code */}
        </div>
    );
};

export default App;