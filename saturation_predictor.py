def compute_trend(history):
    if len(history) < 2:
        return 0.0

    diffs = []
    for i in range(1, len(history)):
        diffs.append(history[i] - history[i - 1])

    return sum(diffs) / len(diffs)


def predict_with_saturation(history, max_capacity=100.0):
    if not history:
        return 0.0

    last = history[-1]
    trend = compute_trend(history)

    # saturation damping
    damping = 1.0 - (last / max_capacity)
    damping = max(0.0, damping)

    predicted = last + trend * damping

    # clamp result
    predicted = max(0.0, min(predicted, max_capacity))
    return predicted
