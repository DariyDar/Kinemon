/**
 * Calibration Module - Handles motion calibration process
 * Guides user through setting min/max positions
 */

class Calibration {
    constructor(motionController) {
        this.motionController = motionController;
        this.minValue = null;
        this.maxValue = null;
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

        const currentTilt = this.motionController.getRawTilt();
        this.minValue = currentTilt;

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

        const currentTilt = this.motionController.getRawTilt();
        this.maxValue = currentTilt;

        // Ensure min is actually less than max
        if (this.minValue > this.maxValue) {
            [this.minValue, this.maxValue] = [this.maxValue, this.minValue];
        }

        // Apply calibration to motion controller
        this.motionController.setCalibration(this.minValue, this.maxValue);

        this.currentStep = 'complete';
        this.isCalibrating = false;

        if (this.onComplete) {
            this.onComplete(this.minValue, this.maxValue);
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
        this.minValue = null;
        this.maxValue = null;
        this.currentStep = 'idle';
        this.isCalibrating = false;
        this.motionController.setCalibration(0, 0);
    }

    /**
     * Get calibration values
     */
    getCalibration() {
        return {
            min: this.minValue,
            max: this.maxValue
        };
    }
}
