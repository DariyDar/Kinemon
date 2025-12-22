/**
 * Calibration Module - Handles motion calibration process
 * Guides user through setting min/max positions
 */

class Calibration {
    constructor(motionController) {
        this.motionController = motionController;
        this.minBeta = null;
        this.maxBeta = null;
        this.minGamma = null;
        this.maxGamma = null;
        this.isCalibrating = false;
        this.currentStep = 'idle'; // 'idle', 'waiting_min', 'waiting_max', 'complete'

        this.onStepChange = null; // Callback for UI updates
        this.onComplete = null; // Callback when calibration is done
    }

    /**
     * Start calibration process
     */
    async start() {
        this.isCalibrating = true;
        this.currentStep = 'waiting_min';
        this.minValue = null;
        this.maxValue = null;

        if (this.onStepChange) {
            this.onStepChange(this.currentStep);
        }
    }

    /**
     * Record current position as minimum (bottom position)
     */
    setMinPosition() {
        if (this.currentStep !== 'waiting_min') return;

        const orientation = this.motionController.getRawOrientation();
        this.minBeta = orientation.beta;
        this.minGamma = orientation.gamma;

        console.log('Min position set:', orientation);

        this.currentStep = 'waiting_max';
        if (this.onStepChange) {
            this.onStepChange(this.currentStep);
        }
    }

    /**
     * Record current position as maximum (top position)
     */
    setMaxPosition() {
        if (this.currentStep !== 'waiting_max') return;

        const orientation = this.motionController.getRawOrientation();
        this.maxBeta = orientation.beta;
        this.maxGamma = orientation.gamma;

        console.log('Max position set:', orientation);

        // Calculate ranges for both axes
        const betaRange = Math.abs(this.maxBeta - this.minBeta);
        const gammaRange = Math.abs(this.maxGamma - this.minGamma);

        console.log('Ranges - Beta:', betaRange, 'Gamma:', gammaRange);

        // Choose axis with greater range
        const useAxis = betaRange >= gammaRange ? 'beta' : 'gamma';
        let minValue, maxValue;

        if (useAxis === 'beta') {
            minValue = Math.min(this.minBeta, this.maxBeta);
            maxValue = Math.max(this.minBeta, this.maxBeta);
        } else {
            minValue = Math.min(this.minGamma, this.maxGamma);
            maxValue = Math.max(this.minGamma, this.maxGamma);
        }

        console.log(`Using ${useAxis} axis: [${minValue.toFixed(1)}, ${maxValue.toFixed(1)}]`);

        // Apply calibration to motion controller
        this.motionController.setCalibration(minValue, maxValue, useAxis);

        this.currentStep = 'complete';
        this.isCalibrating = false;

        if (this.onComplete) {
            this.onComplete(minValue, maxValue);
        }
    }

    /**
     * Get current calibration step
     */
    getCurrentStep() {
        return this.currentStep;
    }

    /**
     * Check if calibration is complete
     */
    isComplete() {
        return this.currentStep === 'complete';
    }

    /**
     * Reset calibration
     */
    reset() {
        this.minBeta = null;
        this.maxBeta = null;
        this.minGamma = null;
        this.maxGamma = null;
        this.currentStep = 'idle';
        this.isCalibrating = false;
        this.motionController.setCalibration(0, 0, 'beta');
    }

    /**
     * Get calibration values
     */
    getCalibration() {
        return this.motionController.getCalibrationData();
    }
}
